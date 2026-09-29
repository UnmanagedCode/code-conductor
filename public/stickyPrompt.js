// Sticky prompt header: while a turn runs long, the prompt that started it stays
// pinned at the top of the transcript (clamped to a few lines by CSS), the next
// prompt pushes it off, scrolling back above a prompt leaves it in place, and
// clicking the pin jumps to the full original bubble.
//
// One overlay element outside the scroll root, not per-turn `position: sticky`
// wrappers: the transcript is a flat list whose lazy-history splice depends on
// root-level sibling adjacency, and a sticky bubble that clamps once stuck would
// shift the content below it. The overlay changes no transcript DOM and leaves
// scrollHeight alone, so auto-scroll and history paging are untouched.
//
// Which bubbles pin is decided at pick time from each bubble's
// `data-prompt-origin` (stamped by Conversation._renderUserEcho) and the live
// session role — see public/promptOrigin.js.

import { isPinEligible } from './promptOrigin.js';

// A bubble whose top is this far above the viewport top counts as scrolled past.
const SCROLLED_PAST = -1;

// Pure geometry. `topAt(i)` is the top of the i-th eligible bubble relative to
// the viewport top, in document order (so non-decreasing). Returns the last
// bubble scrolled above the top, plus the (≤ 0) shift that pushes the pin up as
// the next bubble's top comes within `pinHeight` of the top; null when no
// bubble has scrolled above it.
export function pickPinned(topAt, n, pinHeight) {
  let lo = 0;
  let hi = n - 1;
  let index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topAt(mid) < SCROLLED_PAST) { index = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (index < 0) return null;
  const next = index + 1 < n ? topAt(index + 1) : Infinity;
  return { index, shift: Math.min(0, next - pinHeight) };
}

export function installStickyPrompt({ scrollEl, pinEl, isConducted, viewHostEl, schedule = requestAnimationFrame }) {
  let eligible = null;   // null = dirty; rebuilt on the next refresh
  let eligibleFor = null; // the session role `eligible` was filtered for
  let pinned = null;     // the bubble the pin's clone shows, visible or pushed off
  let pinHeight = 0;     // that clone's height, measured while it was visible
  let pending = false;

  const refreshSoon = () => {
    if (pending) return;
    pending = true;
    schedule(() => { pending = false; refresh(); });
  };

  // Nothing to pin: drop the clone. A pin merely pushed off keeps its clone
  // (see refresh), so it is not dropped here.
  const hide = () => {
    if (!pinned && pinEl.hidden) return;
    pinned = null;
    pinEl.hidden = true;
    pinEl.replaceChildren();
    pinEl.style.transform = '';
  };

  const show = (bubble) => {
    const text = bubble.querySelector(':scope > .blocks > .user-text');
    const body = document.createElement('div');
    body.className = 'pinned-prompt-body';
    body.appendChild(text.cloneNode(true));
    pinEl.replaceChildren(body);
    pinEl.hidden = false;
    body.classList.toggle('overflowing', body.scrollHeight > body.clientHeight + 1);
    pinned = bubble;
  };

  function refresh() {
    // Eligibility is judged here, not when the bubble renders, so a late
    // instances-list update can never leave a stale decision baked in.
    const conducted = !!isConducted();
    if (!eligible || eligibleFor !== conducted) {
      eligible = [...scrollEl.querySelectorAll(':scope > .msg.user[data-prompt-origin]')]
        .filter(b => isPinEligible(b.dataset.promptOrigin, { conducted }));
      eligibleFor = conducted;
    }
    const list = eligible;
    const top0 = scrollEl.getBoundingClientRect().top + scrollEl.clientTop;
    const topAt = i => list[i].getBoundingClientRect().top - top0;

    // The clone re-wraps on resize under an unchanged pinned bubble; a hidden
    // (pushed-off) pin cannot be measured, so it keeps its last height.
    if (!pinEl.hidden) pinHeight = pinEl.offsetHeight;
    let pick = pickPinned(topAt, list.length, pinned ? pinHeight : 0);
    if (!pick) { hide(); return; }
    const bubble = list[pick.index];
    if (bubble !== pinned) {
      show(bubble);
      // The push-off depends on the new content's height.
      pinHeight = pinEl.offsetHeight;
      pick = pickPinned(topAt, list.length, pinHeight);
    }
    // Fully pushed off (clipped by the pane): hidden, so it is not focusable
    // either, but the clone stays so the next frame does not re-clone.
    pinEl.hidden = pick.shift + pinHeight <= 0;
    pinEl.style.transform = pick.shift ? `translateY(${pick.shift}px)` : '';
    pinEl.style.setProperty('--conv-scrollbar',
      `${Math.max(0, scrollEl.offsetWidth - scrollEl.clientWidth - 2 * scrollEl.clientLeft)}px`);
  }

  const jumpToPinned = () => {
    if (!pinned || !pinned.isConnected) return;
    const top0 = scrollEl.getBoundingClientRect().top + scrollEl.clientTop;
    scrollEl.scrollTop += pinned.getBoundingClientRect().top - top0;
  };

  // A rebuild is needed whenever a bubble is added or removed at the root:
  // appends, snapshot replay, clear(), lazy-history splices.
  new MutationObserver(() => { eligible = null; refreshSoon(); }).observe(scrollEl, { childList: true });
  scrollEl.addEventListener('scroll', refreshSoon, { passive: true });
  window.addEventListener('resize', refreshSoon);
  // `toggle` does not bubble; a <details> above the viewport shifts everything.
  scrollEl.addEventListener('toggle', refreshSoon, true);

  // A full-page view (Settings, review, commits, costs, plugin) hides the pane
  // with a class on #main; while it does, every rect reads 0 and the pin hides.
  // Closing it fires no scroll, resize or childList event, so its class change
  // is what brings the pin back.
  if (viewHostEl) new MutationObserver(refreshSoon).observe(viewHostEl, { attributes: true, attributeFilter: ['class'] });

  pinEl.addEventListener('click', jumpToPinned);
  pinEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    jumpToPinned();
  });

  return { refresh };
}
