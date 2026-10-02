// Focus the prompt bar after the user selects a session. `selectInstance`
// (app.js) calls afterSelect(opts) last; the caller that owns the DOM gesture
// passes `{ userGesture: true }`, and the default is off so a passive
// selection (page-load restore, popstate) never steals focus.
import { TOUCH_QUERY } from './layout.js';

const MODAL_SELECTOR = 'dialog[open], [aria-modal="true"]:not([hidden])';
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'image',
]);

function isTextEntry(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
  return el.isContentEditable === true || el.getAttribute?.('contenteditable') === '' || el.getAttribute?.('contenteditable') === 'true';
}

export function installPromptFocus({ textarea, win = window, doc = document }) {
  function afterSelect({ userGesture } = {}) {
    if (userGesture !== true) return;
    if (textarea.disabled) return;
    if (win.matchMedia(TOUCH_QUERY).matches) return;
    if (doc.querySelector(MODAL_SELECTOR)) return;
    const active = doc.activeElement;
    if (active !== textarea && isTextEntry(active)) return;
    textarea.focus();
  }
  return { afterSelect };
}
