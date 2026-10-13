// Focus the prompt box after the user picks a session — never on a passive
// selection (page-load restore, back/forward), on a touch-primary device (the
// keyboard would cover the transcript), behind an open modal, or while the user
// is typing in another text field.

import { isTextEntry, TOUCH_QUERY } from '@/lib/textEntry';

const MODAL_SELECTOR = '[role="dialog"][data-state="open"], [aria-modal="true"]:not([hidden]), dialog[open]';

export function focusPromptAfterSelect(userGesture: unknown, prompt: HTMLTextAreaElement | null, { win = window, doc = document } = {}) {
  if (userGesture !== true || !prompt || prompt.disabled) return;
  if (win.matchMedia(TOUCH_QUERY).matches) return;
  if (doc.querySelector(MODAL_SELECTOR)) return;
  const active = doc.activeElement;
  if (active !== prompt && isTextEntry(active)) return;
  prompt.focus();
}
