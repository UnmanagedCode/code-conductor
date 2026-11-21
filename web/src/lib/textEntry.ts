// What counts as a touch-primary device, and as a field that raises its soft keyboard when focused.

export const TOUCH_QUERY = '(hover: none)';
/** iOS zooms the page into a focused field whose font is under 16px; a coarse pointer gets 16px. */
export const TOUCH_FIELD_TEXT = 'pointer-coarse:text-base';

/**
 * The traits of a free-text field. Spread only by `ProseInput` / `ProseTextarea` (`web/src/components/ui/prose-field.tsx`).
 * `autocomplete=off` is the spec-correct declaration, but Safari ignores it for contact AutoFill; the associated label those
 * components render is the defence against Safari's closed-source classifier reading the field as a contact field.
 * Whether the "AutoFill Contact" bar is gone is checked only on a device.
 */
export const PROSE_FIELD_PROPS = { autoComplete: 'off', autoCorrect: 'on', autoCapitalize: 'sentences', spellCheck: true } as const;

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'image']);

export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
  const ce = el.getAttribute('contenteditable');
  return (el as HTMLElement).isContentEditable === true || ce === '' || ce === 'true';
}
