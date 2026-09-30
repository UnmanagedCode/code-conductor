// Shared happy-dom shim (not a .test file — run.mjs skips it): happy-dom
// dispatches `hashchange` for history.pushState/replaceState, which browsers
// never do. Install it in any test whose code under test navigates through
// history while a hashchange listener is live; tests/main-view-switch.test.mjs
// holds its positive control.
//
// happy-dom queues one hashchange per hash-changing URL update, delivered in
// order. A history call's event is identified by its (oldURL, newURL) pair and
// stopped in a capture listener registered before any app listener; events
// from `location.hash =` still reach the app.
export function installBrowserHashSemantics(window) {
  const pending = [];
  for (const op of ['pushState', 'replaceState']) {
    const orig = window.history[op].bind(window.history);
    window.history[op] = (...args) => {
      const oldURL = window.location.href;
      const oldHash = window.location.hash;
      orig(...args);
      if (window.location.hash !== oldHash) pending.push({ oldURL, newURL: window.location.href });
    };
  }
  window.addEventListener('hashchange', e => {
    const head = pending[0];
    if (head && head.oldURL === e.oldURL && head.newURL === e.newURL) {
      pending.shift();
      e.stopImmediatePropagation();
    }
  }, true);
}
