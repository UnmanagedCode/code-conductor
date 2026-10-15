// Conductor plugin bridge — served by the conductor at /pluginBridge.js and
// included by plugin frontends as a blocking `<script src="/pluginBridge.js">`
// first in `<head>` (no `defer`, so the theme is applied before first paint).
// Standalone (not iframed, or served outside a /plugins/<id>/ mount) it is a
// no-op, so plugins stay independently runnable (a 404 for this script
// outside the embed is harmless).
//
// Protocol: `{cc:1, type, ...}` envelope. Three core messages —
//   child → parent  ready            (bridge alive, initial route follows)
//   child → parent  route {path}     (child-relative path incl. search+hash)
//   parent → child  navigate {path}  (replaceState + synthetic popstate)
// and four optional session-awareness messages, surfaced as `window.ccBridge`
// (absent standalone and on a host without them) —
//   parent → child  session {session}                (the active session, or null)
//   child → parent  openSession {id, sessionId}
//   child → parent  sendPrompt {id, sessionId, text}
//   parent → child  result {id, ok, code?}           (answers one call)
//
// Theme (not a message): the host's resolved theme — `.dark` on the parent's
// <html> — is mirrored onto this page's <html> as `.dark` plus
// `data-cc-theme="light|dark"`, when the script runs and on every change.
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

  // Theme: read the parent's <html> directly (same origin) rather than wait for
  // a message, which could only arrive after DOMContentLoaded. A parent whose
  // document cannot be read (cross-origin) leaves the theme alone.
  var hostRoot = null;
  try { hostRoot = window.parent.document.documentElement; } catch (e) { hostRoot = null; }
  if (hostRoot) {
    var host = hostRoot, root = document.documentElement;
    var syncTheme = function () {
      var dark = host.classList.contains('dark');
      root.classList.toggle('dark', dark);
      root.setAttribute('data-cc-theme', dark ? 'dark' : 'light');
    };
    syncTheme();
    new MutationObserver(syncTheme).observe(host, { attributes: true, attributeFilter: ['class'] });
  }

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

  // Session awareness. `session` stays undefined until the host's first
  // message; a call's promise always resolves ({ok, code?}), never rejects.
  /** @type {{sessionId: string, project: string, worktree: string | null} | null | undefined} */
  var session;
  var hasSession = false;
  /** @type {Array<(s: unknown) => void>} */
  var subscribers = [];
  /** @type {Record<string, (r: {ok: boolean, code?: string}) => void>} */
  var pending = {};
  var nextId = 0;
  /**
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  function call(type, fields) {
    var id = 'b' + (++nextId);
    return new Promise(function (resolve) {
      pending[id] = resolve;
      /** @type {Record<string, unknown>} */
      var msg = { cc: 1, type: type, id: id };
      for (var k in fields) msg[k] = fields[k];
      window.parent.postMessage(msg, origin);
    });
  }
  /** @type {any} */ (window).ccBridge = {
    get session() { return session; },
    /** @param {(s: unknown) => void} fn */
    onSession: function (fn) {
      subscribers.push(fn);
      if (hasSession) fn(session);
      return function () {
        var i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    /** @param {string} sessionId */
    openSession: function (sessionId) { return call('openSession', { sessionId: sessionId }); },
    /** @param {string} sessionId @param {string} text */
    sendPrompt: function (sessionId, text) { return call('sendPrompt', { sessionId: sessionId, text: text }); },
  };

  window.addEventListener('message', function (ev) {
    if (ev.origin !== origin) return;
    var d = ev.data;
    if (!d || d.cc !== 1) return;
    if (d.type === 'session') {
      session = d.session;
      hasSession = true;
      subscribers.slice().forEach(function (fn) { fn(session); });
      return;
    }
    if (d.type === 'result' && typeof d.id === 'string' && pending[d.id]) {
      var resolve = pending[d.id];
      delete pending[d.id];
      resolve(d.ok ? { ok: true } : { ok: false, code: d.code });
      return;
    }
    if (d.type !== 'navigate' || typeof d.path !== 'string') return;
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
