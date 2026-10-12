// Focus handling for the app's Radix modals. None has a Radix Trigger — each opens from a store or local state — so
// Radix's close hands focus to a Trigger that is not there, and it falls to the page.
import * as React from 'react';

/**
 * `onOpenAutoFocus` that focuses the modal's own content instead of its first control. Preventing the
 * auto-focus alone leaves focus outside, and Radix's focus trap only holds focus that has landed inside.
 */
export function focusContent(e: Event) {
  e.preventDefault();
  (e.currentTarget as HTMLElement).focus();
}

/**
 * The control focus returns to when a modal opened from `el` closes. A Radix menu item is gone by then,
 * so it stands for its menu's trigger (the menu content is `aria-labelledby` the trigger).
 */
export function openerOf(el: Element | null): HTMLElement | null {
  const menu = el?.closest('[role="menu"]');
  if (menu) {
    const trigger = menu.getAttribute('aria-labelledby');
    return trigger ? document.getElementById(trigger) : null;
  }
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/** Each mounted modal's content element → the control it was opened from. */
const openers = new WeakMap<Element, HTMLElement | null>();

/** The opener while it is on the page; else, when it sat in a modal that has closed since, that modal's opener. */
function returnTarget(opener: HTMLElement | null): HTMLElement | null {
  let el = opener;
  while (el && !el.isConnected) {
    const modal = el.closest('[role="dialog"]');
    el = modal ? openers.get(modal) ?? null : null;
  }
  return el;
}

/**
 * Focus return for a modal shown while `open`: the opener is read on the render that opens it, while an
 * opening menu item still holds focus. `register` is the content's ref; `onCloseAutoFocus` focuses the
 * opener unless something else already took focus (a selection focusing the composer, the next modal).
 */
export function useReturnFocus(open: boolean) {
  const [wasOpen, setWasOpen] = React.useState(open);
  const [opener, setOpener] = React.useState<HTMLElement | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(openerOf(document.activeElement));
  }
  const register = React.useCallback((node: HTMLElement | null) => { if (node) openers.set(node, opener); }, [opener]);
  const onCloseAutoFocus = (e: Event) => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const target = returnTarget(opener);
    if (!target) return;
    e.preventDefault();
    target.focus();
  };
  return { register, onCloseAutoFocus };
}

/** Provided by `Dialog` and `Sheet` (`web/src/components/ui/`), consumed by their content. */
export const ReturnFocusContext = React.createContext<ReturnType<typeof useReturnFocus> | null>(null);

/** The content's `ref` and `onCloseAutoFocus`: the caller's own handler first, then the return when it did not prevent it. */
export function useContentReturnFocus(onCloseAutoFocus?: (e: Event) => void) {
  const rf = React.useContext(ReturnFocusContext);
  return {
    ref: rf?.register,
    onCloseAutoFocus: (e: Event) => {
      onCloseAutoFocus?.(e);
      if (!e.defaultPrevented) rf?.onCloseAutoFocus(e);
    },
  };
}
