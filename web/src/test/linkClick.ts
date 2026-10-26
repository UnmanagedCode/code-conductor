import { act, fireEvent } from '@testing-library/react';

/**
 * Clicks `a` and returns whether the app prevented the default action. A one-shot document listener (which runs after
 * React's root listener) records the flag and then cancels the click itself, so happy-dom never follows the anchor.
 */
export function clickLink(a: Element, init?: MouseEventInit): boolean {
  let prevented = false;
  const listener = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
  document.addEventListener('click', listener);
  try {
    act(() => { fireEvent.click(a, init); });
  } finally {
    document.removeEventListener('click', listener);
  }
  return prevented;
}
