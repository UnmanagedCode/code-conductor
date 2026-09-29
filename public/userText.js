// Builds a user message's text body: rendered-markdown by default (most user
// turns are conductor-authored briefs/forwards/rebase prompts, heavily
// markdown), with a raw/rendered toggle for pasted logs or code where
// rendering would mislead, and a copy that always yields the exact source
// text regardless of which view is showing.
//
// `controls` is returned separately rather than appended inside `body`: it
// must land in the user bubble's role row; the placement rule is in
// viewControls.js.

import { el } from './dom.js';
import { renderMarkdownInto } from './markdown.js';
import { buildViewControls } from './viewControls.js';

// `renderInto` builds the rendered view; defaults to the markdown renderer.
// Folded bubbles (wake, skill and renew-seed, see foldedText.js) may pass a
// variant instead: wake splits off a leading metadata line first, renew-seed
// splits the summary into labelled sections; skill uses the default.
export function buildUserText(text, { renderInto = renderMarkdownInto } = {}) {
  const body = el('div', { class: 'block text user-text' });

  const showRendered = () => {
    body.classList.add('md');
    renderInto(body, text);
    body.dataset.view = 'rendered';
  };
  const showRaw = () => {
    body.classList.remove('md');
    body.textContent = text;
    body.dataset.view = 'raw';
  };
  showRendered();

  const controls = buildViewControls({
    getCopyText: () => text,
    onViewChange: v => v === 'raw' ? showRaw() : showRendered(),
  });
  return { body, controls };
}
