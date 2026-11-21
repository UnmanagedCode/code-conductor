// The oracle for a prose field (`ProseInput` / `ProseTextarea`): what its control must expose.

export const PROSE_TRAITS = { autocomplete: 'off', autocorrect: 'on', autocapitalize: 'sentences', spellcheck: 'true' };

/** A prose field's trait attributes, its `name`, its aria name overrides, and the texts of the <label>s whose htmlFor is its id. */
export function proseFacts(el: HTMLElement) {
  return {
    traits: Object.fromEntries(Object.keys(PROSE_TRAITS).map((k) => [k, el.getAttribute(k)])),
    name: el.getAttribute('name'),
    ariaLabel: el.getAttribute('aria-label'),
    labelledBy: el.getAttribute('aria-labelledby'),
    labels: [...el.ownerDocument.querySelectorAll('label')].filter((l) => el.id !== '' && l.htmlFor === el.id).map((l) => l.textContent),
  };
}

/** The facts of a prose field named `label`: the traits, no `name`, and that one associated <label> as its sole name source. */
export const proseExpected = (label: string) => ({ traits: PROSE_TRAITS, name: null, ariaLabel: null, labelledBy: null, labels: [label] });
