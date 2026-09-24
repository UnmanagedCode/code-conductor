// Builds a user message's text body: rendered-markdown by default (most user
// turns are conductor-authored briefs/forwards/rebase prompts, heavily
// markdown), with a raw/rendered toggle for pasted logs or code where
// rendering would mislead, and a copy that always yields the exact source
// text regardless of which view is showing.
//
// `controls` is returned separately rather than appended inside `body`: it
// must land in the user bubble's role row, with its own CSS class, never
// inside `.user-msg-actions` (syncSegmentActions removes that whole
// container from retired segments) and never classed `user-msg-action`
// (setUserActionsEnabled disables every one of those during a running turn).

import { el } from './dom.js';
import { renderMarkdownInto } from './markdown.js';
import { copyToClipboard } from './blocks.js';

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

  // No aria-pressed here: the label names the view a click switches TO, not
  // the current state, so a "pressed" state would contradict the label (a
  // screen reader would announce "md, pressed" while raw text is showing).
  const toggleBtn = el('button', {
    type: 'button', class: 'user-view-btn user-view-toggle',
    title: 'Show raw text',
  }, 'raw');
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (body.dataset.view === 'raw') {
      showRendered();
      toggleBtn.textContent = 'raw';
      toggleBtn.title = 'Show raw text';
    } else {
      showRaw();
      toggleBtn.textContent = 'md';
      toggleBtn.title = 'Show rendered markdown';
    }
  });

  const copyBtn = el('button', {
    type: 'button', class: 'user-view-btn user-view-copy',
    title: 'Copy message text',
  }, 'copy');
  let resetTimer = null;
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const flash = (label, cls) => {
      copyBtn.textContent = label;
      copyBtn.classList.remove('copied', 'failed');
      if (cls) copyBtn.classList.add(cls);
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.textContent = 'copy';
        copyBtn.classList.remove('copied', 'failed');
        resetTimer = null;
      }, 1200);
    };
    Promise.resolve(copyToClipboard(text))
      .then(() => flash('copied', 'copied'))
      .catch(() => flash('failed', 'failed'));
  });

  const controls = el('span', { class: 'user-view-controls' }, toggleBtn, copyBtn);
  return { body, controls };
}
