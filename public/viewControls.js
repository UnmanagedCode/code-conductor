// The raw/rendered toggle + copy pair shared by user and assistant bubbles.
// `buildViewControls` returns the `span.user-view-controls` element only; the
// caller owns what "raw" and "copy" mean for its bubble (`onViewChange`,
// `getCopyText`).
//
// The element must land in the bubble's role row, never inside
// `.user-msg-actions` (syncSegmentActions removes that whole container from
// retired segments) and never classed `user-msg-action` (setUserActionsEnabled
// disables every one of those during a running turn). The class names below
// are deliberately not those.

import { el } from './dom.js';
import { copyToClipboard } from './blocks.js';

// `getCopyText` runs at click time, so a streaming bubble copies what has
// arrived so far. `onViewChange('raw' | 'rendered')` fires on each toggle
// click; the toggle starts at 'rendered'.
export function buildViewControls({ getCopyText, onViewChange }) {
  let view = 'rendered';

  // No aria-pressed here: the label names the view a click switches TO, not
  // the current state, so a "pressed" state would contradict the label (a
  // screen reader would announce "md, pressed" while raw text is showing).
  const toggleBtn = el('button', {
    type: 'button', class: 'user-view-btn user-view-toggle',
    title: 'Show raw text',
  }, 'raw');
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view === 'raw') {
      view = 'rendered';
      toggleBtn.textContent = 'raw';
      toggleBtn.title = 'Show raw text';
    } else {
      view = 'raw';
      toggleBtn.textContent = 'md';
      toggleBtn.title = 'Show rendered markdown';
    }
    onViewChange(view);
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
    Promise.resolve(copyToClipboard(getCopyText()))
      .then(() => flash('copied', 'copied'))
      .catch(() => flash('failed', 'failed'));
  });

  return el('span', { class: 'user-view-controls' }, toggleBtn, copyBtn);
}
