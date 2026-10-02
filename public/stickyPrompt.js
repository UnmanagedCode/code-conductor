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
//
// The pin is summoned, not automatic: it stays hidden until reveal() (Down in
// the composer, a swipe down on the top bar — public/promptReveal.js) and hides
// again on conceal(). While revealed with nothing scrolled past, it pages older
// history into the transcript (in-band: the pin clones the real bubble, and a
// click jumps to it) through the lazy-history controller's loadUntil(), and
// shows a status line instead of a prompt until one pins. The status is derived
// from the run's flags and the history state, never stored.

import { isPinEligible } from './promptOrigin.js';

// A bubble whose top is this far above the viewport top counts as scrolled past.
const SCROLLED_PAST = -1;

export const STATUS_LOADING = 'Loading earlier history…';
export const STATUS_FAILED = 'Couldn’t load earlier history — press ↓ / swipe down to retry';
export const STATUS_NONE = 'No earlier prompt in this session';

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

// `history` is the lazy-history controller's { loadUntil, state }; without it
// nothing autoloads and an empty reveal reads STATUS_NONE.
export function installStickyPrompt({ scrollEl, pinEl, isConducted, viewHostEl, history = null, schedule = requestAnimationFrame }) {
  let eligible = null;   // null = dirty; rebuilt on the next refresh
  let eligibleFor = null; // the session role `eligible` was filtered for
  let pinned = null;     // the bubble the pin's clone shows, visible or pushed off
  let pinHeight = 0;     // that clone's height, measured while it was visible
  let pending = false;
  let revealed = false;
  let running = false;   // a loadUntil run is in flight
  let failed = false;    // the last run stalled: refreshes do not retry, reveal() does
  let runToken = 0;      // bumped by conceal() so a cancelled run's result is ignored
  let statusShown = null; // the status line's text while one shows

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
    statusShown = null;
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
    statusShown = null;
    body.classList.toggle('overflowing', body.scrollHeight > body.clientHeight + 1);
    pinned = bubble;
  };

  const setGutter = () => pinEl.style.setProperty('--conv-scrollbar',
    `${Math.max(0, scrollEl.offsetWidth - scrollEl.clientWidth - 2 * scrollEl.clientLeft)}px`);

  const statusText = () => {
    if (!history) return STATUS_NONE;
    const { ready, hasMore } = history.state();
    if (running || !ready) return STATUS_LOADING;
    if (!hasMore) return STATUS_NONE;
    return failed ? STATUS_FAILED : STATUS_LOADING; // not failed: a run is about to start
  };

  // Revealed with nothing to pin: a status line in the pin's box, rewritten
  // only when its text changes.
  const showStatus = () => {
    const text = statusText();
    if (text === statusShown) return;
    const line = document.createElement('div');
    line.className = 'pinned-prompt-status';
    line.textContent = text;
    pinEl.replaceChildren(line);
    pinEl.hidden = false;
    pinEl.style.transform = '';
    pinned = null;
    statusShown = text;
    setGutter();
  };

  // Synchronous on purpose: loadUntil asks it right after a page is spliced,
  // before the childList records reach the observer below.
  const found = () => {
    eligible = null;
    refresh();
    return pinned !== null;
  };

  // Page history until a prompt pins. No layout (a full-page view is open)
  // starts nothing: every rect reads 0, so nothing would ever be found.
  const kick = () => {
    if (!revealed || running || failed || !history || !(scrollEl.clientHeight > 0)) return;
    const { ready, hasMore } = history.state();
    if (!ready || !hasMore) return;
    const token = ++runToken;
    running = true;
    history.loadUntil(found, () => revealed && token === runToken && scrollEl.clientHeight > 0)
      .then((result) => {
        if (token !== runToken) return;
        running = false;
        failed = result === 'stalled';
        refresh();
      });
  };

  function refresh() {
    if (!revealed) { hide(); return; }
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
    if (!pick) {
      if (!(scrollEl.clientHeight > 0)) { hide(); return; }
      showStatus();
      kick(); // may re-enter refresh through found()
      return;
    }
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
    setGutter();
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
  // is what brings the pin back (and restarts an autoload the view stopped).
  if (viewHostEl) new MutationObserver(refreshSoon).observe(viewHostEl, { attributes: true, attributeFilter: ['class'] });

  pinEl.addEventListener('click', jumpToPinned);
  pinEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    jumpToPinned();
  });

  // Down again after a failure retries: reveal() clears `failed`.
  const reveal = () => {
    revealed = true;
    failed = false;
    refresh();
  };

  // A fetch already in flight still lands in the transcript; the run stops at
  // its next check.
  const conceal = () => {
    revealed = false;
    runToken++;
    running = false;
    failed = false;
    refresh();
  };

  return { refresh, reveal, conceal };
}
