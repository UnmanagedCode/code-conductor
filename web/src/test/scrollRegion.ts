// Structure probes for a dialog's scroll region. happy-dom computes no layout, so
// these read the classes that make one: which ancestors scroll, and which hidden
// Radix form inputs they hold.

/** The ancestors of `el`, below `root`, whose classes make them a vertical scroller. */
export function scrollersBetween(el: Element, root: Element): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
    if (p.classList.contains('overflow-y-auto') || p.classList.contains('overflow-auto')) found.push(p);
  }
  return found;
}

/** The absolutely positioned hidden inputs Radix renders beside each Checkbox inside a form. */
export function bubbleInputs(root: Element): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-hidden="true"]')];
}
