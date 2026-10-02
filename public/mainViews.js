// Owner of "which full-page main view is showing". Every full-page view
// (Settings, and each installHashView view) registers here; whoever takes
// #main — opening a view, or selectInstance claiming it for the conversation —
// calls reconcileMainViews() AFTER the URL already names the new view (or the
// session), and every open view whose hash no longer matches is superseded.
//
// Superseding is not leaving: a superseded view hides and resets but never
// navigates (its leave callback would rewrite the hash the new view just
// set). Its non-navigating notifications still run, and they read the new
// hash — hence reconcile-after-navigate.
//
// CLOSED SIGNAL. Every view calls mainViewClosed() at the end of each exit,
// AFTER whoever restores the URL has done so — most exits restore the session
// anchor through replaceState, which fires no hashchange, so this is the one
// signal an exit is guaranteed to give. onMainViewClosed listeners read the
// hash themselves (public/viewedMarker.js re-checks the pane).
//
// The registry is per window (keyed by the ambient `window`), so each test's
// fresh happy-dom Window starts empty.

const registries = new WeakMap();

function state() {
  let s = registries.get(window);
  if (!s) registries.set(window, s = { views: [], closed: [] });
  return s;
}
const registry = () => state().views;

export function registerMainView({ matches, isOpen, supersede }) {
  registry().push({ matches, isOpen, supersede });
}

export function onMainViewClosed(listener) {
  state().closed.push(listener);
}

export function mainViewClosed() {
  for (const listener of state().closed) listener();
}

export function reconcileMainViews() {
  const hash = window.location.hash;
  for (const view of registry()) {
    if (view.isOpen() && !view.matches(hash)) view.supersede();
  }
}

// Whether a registered full-page view owns `hash` — i.e. covers the
// conversation pane.
export function isMainViewHash(hash) {
  return registry().some(v => v.matches(hash));
}
