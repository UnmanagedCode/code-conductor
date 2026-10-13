// Keyboard focus around sonner's toasts. sonner's list remembers where focus
// entered it from and sends focus back there whenever focus leaves the list, so a
// forward Tab out of a toast lands back on the page element it came from.
// installToastFocus hides Tab and click entries from sonner (Alt+T's own focus of
// the list still reaches it, keeping sonner's return for the hotkey), and itself
// returns focus to where it came from once a dismissal removes the toast element
// holding it. Each hidden focusin is re-dispatched from the toaster's <section>,
// because document listeners (Radix's focus-outside dismissal and focus traps)
// must still see focus arrive outside their layers.

const LIST = '[data-sonner-toaster]';

type Focusable = HTMLElement | SVGElement;

/** Installs the focus handling on sonner's <section> (the Toaster's ref); returns the uninstaller. */
export function installToastFocus(section: HTMLElement): () => void {
  let origin: Focusable | null = null; // the page element a Tab or click entry came from
  let held: Element | null = null; // the toaster element holding focus
  let announced: FocusEvent | null = null; // our own re-dispatch, passed through untouched
  const inside = (n: EventTarget | null): n is Node => n instanceof Node && section.contains(n);
  const forget = () => { origin = null; held = null; };

  const onFocusIn = (e: FocusEvent) => {
    if (e === announced) return;
    const target = e.target as Element;
    const from = e.relatedTarget;
    held = target;
    if (target.matches(LIST) && !inside(from)) { origin = null; return; } // Alt+T: sonner's own
    e.stopPropagation();
    if ((from instanceof HTMLElement || from instanceof SVGElement) && !inside(from)) origin = from;
    announced = new FocusEvent('focusin', { bubbles: true, composed: true, relatedTarget: from });
    try { section.dispatchEvent(announced); } finally { announced = null; }
  };

  const onFocusOut = (e: FocusEvent) => {
    if (inside(e.relatedTarget)) return; // a move within the toaster
    if (e.relatedTarget) { forget(); return; } // focus moved on to the page
    // No relatedTarget: the element is being removed, or focus is leaving the document
    // (Tab past the toaster, the page's last stop, or a window switch). Decide once it settles.
    const left = e.target as Node;
    setTimeout(() => {
      if (held === left && left.isConnected && !inside(document.activeElement)) forget();
    });
  };

  // A dismissal removes the focused toast element: checked on the removal itself, whether or not the engine blurs it on the way out.
  const observer = new MutationObserver(() => {
    if (!held || held.isConnected) return;
    const to = origin;
    forget();
    const active = document.activeElement;
    if (!to || (active && active !== document.body)) return;
    if (to.isConnected) to.focus({ preventScroll: true });
  });

  section.addEventListener('focusin', onFocusIn);
  section.addEventListener('focusout', onFocusOut);
  observer.observe(section, { childList: true, subtree: true });
  return () => {
    section.removeEventListener('focusin', onFocusIn);
    section.removeEventListener('focusout', onFocusOut);
    observer.disconnect();
  };
}
