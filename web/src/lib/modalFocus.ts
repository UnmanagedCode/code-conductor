// Focus handling for the app's Radix modals. None has a Radix Trigger — each opens from a store or local state — so
// Radix's close hands focus to a Trigger that is not there, and it falls to the page.
import * as React from 'react';
import { isTextEntry, TOUCH_QUERY } from '@/lib/textEntry';

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

/**
 * The latest elements focus was sent to, newest last: a modal still trapping focus (the phone drawer behind a confirm
 * it raised) sends an `autoFocus` straight back out, and only these events name where it was headed.
 */
const recentlySent: Element[] = [];
let tracking = false;
function trackFocusSends() {
  if (tracking) return;
  tracking = true;
  const note = (el: EventTarget | null) => {
    if (!(el instanceof Element)) return;
    recentlySent.push(el);
    if (recentlySent.length > 8) recentlySent.shift();
  };
  window.addEventListener('focusin', (e) => note(e.target), true);
  window.addEventListener('focusout', (e) => note(e.relatedTarget), true);
}

/** Each modal content seen mounting → the control its markup's `autoFocus` focused then, if any. */
const autoFocused = new WeakMap<Element, HTMLElement | null>();

/**
 * Holds the content's `autoFocus` target until the focus trap can take it. React focuses it as the content mounts,
 * a render before Radix's trap attaches; the trap then finds focus already inside, skips its opening auto-focus and
 * never learns the focused control, so it cannot pull focus back when a closing menu or drawer takes it. Blurred
 * here, the target is focused again from the opening auto-focus (`openFocus`), which the trap sees. A target a
 * still-trapping modal sent focus back from is found among the elements focus was recently sent to.
 */
function holdAutoFocus(node: HTMLElement) {
  if (autoFocused.has(node)) return;
  const active = document.activeElement;
  const target = node.contains(active) ? active : recentlySent.findLast((el) => node.contains(el)) ?? null;
  autoFocused.set(node, target instanceof HTMLElement ? target : null);
  if (target === active && target instanceof HTMLElement) target.blur();
}

/** Whether `el` can take focus now: still on the page and not disabled. */
const focusable = (el: HTMLElement) => el.isConnected && !(el as HTMLButtonElement).disabled;

/** Hidden the way Radix's focus scope judges it: `visibility: hidden` itself, or `display: none` up to `root`. */
function hidden(el: HTMLElement, root: HTMLElement) {
  if (getComputedStyle(el).visibility === 'hidden') return true;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.parentElement) if (getComputedStyle(n).display === 'none') return true;
  return false;
}

/** Radix's own opening target when no control auto-focuses: the first tabbable, visible control that is not a link. */
function firstTabbable(root: HTMLElement): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.tagName === 'A' || el.hidden || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden')) continue;
    if (el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !hidden(el, root)) return el;
  }
  return null;
}

/**
 * The opening focus: the `autoFocus` target while it can still take focus, else the first control, else the content.
 * On a touch device a text-field target opens on the content instead, so no soft keyboard covers the modal as it
 * opens; there the target is judged and focused here. Elsewhere, with no `autoFocus` target, Radix's default runs.
 */
function openFocus(e: Event) {
  const content = e.currentTarget as HTMLElement;
  const auto = autoFocused.get(content);
  const held = auto && focusable(auto) ? auto : null;
  if (window.matchMedia(TOUCH_QUERY).matches) {
    const target = held ?? firstTabbable(content);
    e.preventDefault();
    if (target && !isTextEntry(target)) target.focus();
    if (document.activeElement !== target) content.focus();
  } else if (held) {
    e.preventDefault();
    held.focus();
  }
}

/**
 * The content's `ref`, `onOpenAutoFocus` and `onCloseAutoFocus`: each handler runs the caller's own first, then the
 * opening focus or the return when the caller did not prevent it.
 */
export function useContentFocus(onOpenAutoFocus?: (e: Event) => void, onCloseAutoFocus?: (e: Event) => void) {
  trackFocusSends();
  const rf = React.useContext(ReturnFocusContext);
  const register = rf?.register;
  return {
    ref: React.useCallback((node: HTMLElement | null) => {
      register?.(node);
      if (node) holdAutoFocus(node);
    }, [register]),
    onOpenAutoFocus: (e: Event) => {
      onOpenAutoFocus?.(e);
      if (!e.defaultPrevented) openFocus(e);
    },
    onCloseAutoFocus: (e: Event) => {
      onCloseAutoFocus?.(e);
      if (!e.defaultPrevented) rf?.onCloseAutoFocus(e);
    },
  };
}
