// Conductor plugin bridge — served by the conductor at /pluginBridge.js and
// included by plugin frontends via `<script src="/pluginBridge.js" defer>`.
// Standalone (not iframed, or served outside a /plugins/<id>/ mount) it is a
// no-op, so plugins stay independently runnable (a 404 for this script
// outside the embed is harmless).
//
// Protocol: `{cc:1, type, ...}` envelope, exactly three messages —
//   child → parent  ready            (bridge alive, initial route follows)
//   child → parent  route {path}     (child-relative path incl. search+hash)
//   parent → child  navigate {path}  (replaceState + synthetic popstate)
//
// History contract: entering a plugin costs exactly ONE joint history entry,
// so hardware Back always lands on the conductor. The bridge enforces it by
// patching pushState → replaceState inside the iframe. (Documented
// limitation: multi-page — non-SPA — plugins still pollute joint history.)
(function () {
  'use strict';
  if (window.self === window.top) return;
  var m = /^\/plugins\/([a-z][a-z0-9-]*)/.exec(window.location.pathname);
  if (!m) return;
  var prefix = '/plugins/' + m[1];
  var origin = window.location.origin;
  var replace = history.replaceState.bind(history);

  function currentPath() {
    var p = window.location.pathname;
    if (p.indexOf(prefix) === 0) p = p.slice(prefix.length) || '/';
    return p + window.location.search + window.location.hash;
  }
  function reportRoute() {
    window.parent.postMessage({ cc: 1, type: 'route', path: currentPath() }, origin);
  }

  history.pushState = function (state, title, url) {
    replace(state, title, url);
    reportRoute();
  };
  history.replaceState = function (state, title, url) {
    replace(state, title, url);
    reportRoute();
  };
  window.addEventListener('popstate', reportRoute);
  window.addEventListener('hashchange', reportRoute);

  window.addEventListener('message', function (ev) {
    if (ev.origin !== origin) return;
    var d = ev.data;
    if (!d || d.cc !== 1 || d.type !== 'navigate' || typeof d.path !== 'string') return;
    replace(null, '', prefix + d.path);
    // Nudge SPA routers the way a real back/forward would.
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });

  function announce() {
    window.parent.postMessage({ cc: 1, type: 'ready' }, origin);
    reportRoute();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce);
  } else {
    announce();
  }
})();
