// Full-page iframe view for plugin frontends, owning the `#plugin/<id>/
// <subpath>` hash space. Built on installHashView's scaffold via the
// additive `matchHash` predicate (Escape/back/teardown mechanics shared
// with review/commits/costs); opening is hash-driven here because — unlike
// those views — entry points are the app switcher, links and page load,
// not an open() call site.
//
// Parent side of the plugin bridge (public/pluginBridge.js runs inside the
// iframe): child `route` messages mirror into the hash via replaceState
// (no hashchange fires, so no reload loop); external subpath changes are
// forwarded as `navigate` messages instead of reloading the iframe.
// Teardown blanks the iframe so a closed plugin costs no memory.

import { installHashView } from './hashView.js';

const PREFIX = '#plugin/';
const HASH_RE = /^#plugin\/([a-z][a-z0-9-]*)(\/.*)?$/;

export function installPluginView() {
  const view = document.getElementById('plugin-view');
  if (!view) return {};

  let iframe = null;
  let current = null; // { id, subpath } of the loaded iframe

  function parseHash(h) {
    const m = HASH_RE.exec(h);
    return m ? { id: m[1], subpath: m[2] ?? '/' } : null;
  }

  function load(target) {
    current = target;
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'plugin-frame';
      view.appendChild(iframe);
    }
    iframe.src = `/plugins/${target.id}${target.subpath}`;
  }

  const hv = installHashView({
    name: 'plugin',
    matchHash: h => h.startsWith(PREFIX),
    navigate: () => {}, // the hash is already set by whoever navigated here
    onShow: () => {
      const target = parseHash(location.hash);
      if (target) load(target);
    },
    onTeardown: () => {
      current = null;
      if (iframe) iframe.src = 'about:blank';
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

  return {};
}
