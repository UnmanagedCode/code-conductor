// What counts as a touch-primary device, and as a field that raises its soft keyboard when focused.

export const TOUCH_QUERY = '(hover: none)';
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'image']);

export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
  const ce = el.getAttribute('contenteditable');
  return (el as HTMLElement).isContentEditable === true || ce === '' || ce === 'true';
}
