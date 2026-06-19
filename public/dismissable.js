// Shared "click-outside / Escape to dismiss" listener wiring for the header
// usage popover and the two ⋮ overflow menus (header + sidebar). All three
// armed an identical pair of document-level *capture-phase* listeners —
// `pointerdown` (close on outside-click) and `keydown` (close on Escape) —
// and tore them down on close. This factory owns exactly that listener pair.
//
// Callers keep their own show/hide/position logic and supply:
//   - isInside(target): whether an event target counts as "inside" the
//     surface, so a pointerdown there does NOT dismiss it.
//   - onDismiss():       invoked to actually close the surface. Callers route
//                        this back through their existing close fn (which in
//                        turn calls disarm()).
//
// `arm()` adds the listeners in capture phase (pointerdown then keydown);
// `disarm()` removes them in the same order and is idempotent. `armed`
// reports whether the listeners are currently attached — it mirrors the
// non-null open-flag the callers previously kept by hand.
export function makeDismissable({ isInside, onDismiss }) {
  let dismiss = null;
  return {
    get armed() { return dismiss !== null; },
    arm() {
      dismiss = (ev) => {
        if (ev.type === 'keydown') {
          if (ev.key === 'Escape') onDismiss();
          return;
        }
        if (isInside(ev.target)) return;
        onDismiss();
      };
      document.addEventListener('pointerdown', dismiss, true);
      document.addEventListener('keydown', dismiss, true);
    },
    disarm() {
      if (!dismiss) return;
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      dismiss = null;
    },
  };
}
