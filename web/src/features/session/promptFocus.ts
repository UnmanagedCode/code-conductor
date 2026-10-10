// Focus the prompt box after the user picks a session — never on a passive
// selection (page-load restore, back/forward), on a touch-primary device (the
// keyboard would cover the transcript), behind an open modal, or while the user
// is typing in another text field.

const MODAL_SELECTOR = '[role="dialog"][data-state="open"], [aria-modal="true"]:not([hidden]), dialog[open]';
export const TOUCH_QUERY = '(hover: none)';
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'image']);

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
  const ce = el.getAttribute('contenteditable');
  return (el as HTMLElement).isContentEditable === true || ce === '' || ce === 'true';
}

export function focusPromptAfterSelect(userGesture: unknown, prompt: HTMLTextAreaElement | null, { win = window, doc = document } = {}) {
  if (userGesture !== true || !prompt || prompt.disabled) return;
  if (win.matchMedia(TOUCH_QUERY).matches) return;
  if (doc.querySelector(MODAL_SELECTOR)) return;
  const active = doc.activeElement;
  if (active !== prompt && isTextEntry(active)) return;
  prompt.focus();
}
