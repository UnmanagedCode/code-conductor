// Focus handling for a Radix modal opened from a store rather than its own Trigger, with no control preselected.
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

/**
 * Focus handlers for a modal shown while `open`: it opens focused on its content, and closing returns focus
 * to the control it was opened from — Radix hands it to the modal's own Trigger, which a store-opened modal
 * lacks. The opener is read on the render that opens it, while an opening menu item still holds focus.
 */
export function useModalFocus(open: boolean) {
  const [wasOpen, setWasOpen] = React.useState(open);
  const [opener, setOpener] = React.useState<HTMLElement | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(openerOf(document.activeElement));
  }
  return {
    onOpenAutoFocus: focusContent,
    onCloseAutoFocus: (e: Event) => {
      if (!opener?.isConnected) return;
      e.preventDefault();
      opener.focus();
    },
  };
}
