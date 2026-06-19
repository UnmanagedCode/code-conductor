// Shared scaffold for the full-page, hash-routed views (review, commits, costs).
// Each such view is a `#<name>-view` section toggled by `location.hash`, with a
// `main.<name>-open` body class, an Escape `keydown` handler, a `← Back`
// affordance, and a `hashchange` teardown when the hash leaves. The user-facing
// close always routes through history (back button + Escape both call
// `history.back()`, which fires `hashchange`, whose handler runs the teardown);
// the public `close()` runs the same teardown directly.
//
// Per-view differences stay injected, NOT flattened:
//   - `navigate`  — the exact history op that opens the view (hash= vs pushState).
//   - `escapeCapture` — capture phase (commits/costs) vs bubble (review). This
//     phase split is load-bearing: commits' capture-phase handler runs first and
//     bails (`canEscape`) while the diff is layered on top (`#review` visible),
//     letting review's bubble-phase handler own Escape — so they don't both fire.
//   - `keepOpenHashes` — extra hashes that must NOT tear the view down
//     (commits stays open while `#review` is layered on top).
//   - `canEscape` — an extra Escape guard (commits: only when review-view hidden).
//   - `guard` — gates open()/teardown when the view element may be absent (costs).
//   - `onShow` / `onTeardown` — the per-view data load and state reset + callback.
//
// settings.js intentionally does NOT use this helper — it syncs bidirectionally
// on hashchange, closes via close() (not history.back()), guards re-entrant
// show() with an isOpen flag, opens by setting the hash only, and has no back
// button. Forcing it here would change behavior.

export function installHashView({
  name,
  escapeCapture = false,
  keepOpenHashes = [],
  canEscape,
  guard,
  navigate,
  onShow,
  onTeardown,
} = {}) {
  const getEl = id => document.getElementById(id);
  const viewId = `${name}-view`;
  const hash = `#${name}`;
  const backId = `${name}-back`;
  const openClass = `${name}-open`;

  // Matches the originals' truthiness exactly: a missing element reads as
  // "visible" (`!undefined === true`). The optional `guard` handles absence.
  const isVisible = () => !getEl(viewId)?.hidden;

  function show() {
    getEl(viewId).hidden = false;
    getEl('main').classList.add(openClass);
  }

  function hide() {
    getEl(viewId).hidden = true;
    getEl('main').classList.remove(openClass);
  }

  function teardown() {
    if (guard && !guard()) return;
    hide();
    onTeardown?.();
  }

  function open(arg) {
    if (guard && !guard()) return;
    navigate();
    show();
    onShow?.(arg);
  }

  function close() {
    teardown();
  }

  // Listeners attached in the originals' order: back-click → keydown → hashchange.
  getEl(backId)?.addEventListener('click', () => history.back());

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isVisible() && (!canEscape || canEscape())) {
      history.back();
    }
  }, escapeCapture);

  window.addEventListener('hashchange', () => {
    if (![hash, ...keepOpenHashes].includes(location.hash) && isVisible()) {
      teardown();
    }
  });

  return { open, close };
}
