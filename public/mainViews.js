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
// The registry is per window (keyed by the ambient `window`), so each test's
// fresh happy-dom Window starts empty.

const registries = new WeakMap();

function registry() {
  let views = registries.get(window);
  if (!views) registries.set(window, views = []);
  return views;
}

export function registerMainView({ matches, isOpen, supersede }) {
  registry().push({ matches, isOpen, supersede });
}

export function reconcileMainViews() {
  const hash = window.location.hash;
  for (const view of registry()) {
    if (view.isOpen() && !view.matches(hash)) view.supersede();
  }
}
