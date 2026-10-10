// Sticky prompt: on demand (↓ at the end of the composer, a swipe down on the
// session header), the prompt that started the turn being read stays pinned
// at the top of the transcript; the next prompt pushes it off, and tapping the
// pin jumps to the full bubble. When no eligible prompt is rendered yet it pages
// older history in until one is (lazyHistory.loadUntil).
//
// DOM geometry by necessity: which bubble is "above the fold" is a layout fact.
import { isPinEligible } from '../../../public/promptOrigin.ts';
import { createStore } from '@/state/createStore';

const SCROLLED_PAST = -1;
export const STATUS_LOADING = 'Loading earlier history…';
export const STATUS_FAILED = "Couldn't load earlier history. Press ↓ or swipe down to retry.";
export const STATUS_NONE = 'No earlier prompt in this session';

/** The last bubble scrolled past the top (binary search), and how far the next one pushes the pin up. */
export function pickPinned(topAt: (i: number) => number, n: number, pinHeight: number) {
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

export type PinState =
  | { kind: 'hidden' }
  | { kind: 'status'; text: string }
  | { kind: 'pinned'; html: string; shift: number; overflowing: boolean; pushedOff: boolean };

export const pinStore = createStore<{ pin: PinState; gutter: number }>({ pin: { kind: 'hidden' }, gutter: 0 });

type History = {
  status: { get: () => { visible: boolean; loading: boolean } };
  loadUntil: (found: () => boolean, keepGoing: () => boolean) => Promise<string>;
};

export function createStickyPrompt({ isConducted, getActiveId, history, isHistoryReady }: {
  isConducted: () => boolean;
  getActiveId: () => string | null;
  history: History;
  isHistoryReady: () => boolean;
}) {
  let scrollEl: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let pinEl: HTMLElement | null = null;
  let eligible: HTMLElement[] | null = null;
  let eligibleFor: boolean | null = null;
  let pinned: HTMLElement | null = null;
  let pinHeight = 0;
  let pending = false;
  let revealed = false;
  let revealedFor: string | null = null;
  let running = false;
  let failed = false;
  let runToken = 0;
  let observer: MutationObserver | null = null;

  const set = (pin: PinState) => pinStore.set({ pin });
  const refreshSoon = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; refresh(); });
  };
  const hide = () => {
    pinned = null;
    if (pinStore.get().pin.kind !== 'hidden') set({ kind: 'hidden' });
  };
  const textOf = (bubble: HTMLElement) => bubble.querySelector<HTMLElement>('[data-user-text]');
  // < 1, not <= 0: sub-pixel scroll residue on a fractional device-pixel ratio must not leave a sliver showing.
  const isPushedOff = (shift: number) => shift + pinHeight < 1;
  const syncGutter = () => {
    const g = Math.max(0, scrollEl!.offsetWidth - scrollEl!.clientWidth - 2 * scrollEl!.clientLeft);
    if (pinStore.get().gutter !== g) pinStore.set({ gutter: g });
  };

  const statusText = () => {
    const { visible } = history.status.get();
    if (running || !isHistoryReady()) return STATUS_LOADING;
    if (!visible) return STATUS_NONE;
    return failed ? STATUS_FAILED : STATUS_LOADING;
  };

  const found = () => {
    eligible = null;
    refresh();
    return pinned !== null;
  };

  const kick = () => {
    if (!revealed || running || failed || !scrollEl || !(scrollEl.clientHeight > 0)) return;
    if (!isHistoryReady() || !history.status.get().visible) return;
    const token = ++runToken;
    running = true;
    history.loadUntil(found, () => revealed && token === runToken && !!scrollEl && scrollEl.clientHeight > 0).then((result) => {
      if (token !== runToken) return;
      running = false;
      failed = result === 'stalled';
      refresh();
    });
  };

  const stopRevealing = () => {
    revealed = false;
    runToken++;
    running = false;
    failed = false;
  };

  function refresh() {
    // Detached (the view unmounted): a queued refresh must not touch the shared pin.
    if (!scrollEl || !listEl) return;
    if (revealed && getActiveId() !== revealedFor) stopRevealing();
    if (!revealed) { hide(); return; }
    syncGutter();
    const conducted = isConducted();
    if (!eligible || eligibleFor !== conducted) {
      eligible = [...listEl.querySelectorAll<HTMLElement>(':scope > [data-item="user"][data-prompt-origin]')]
        .filter((b) => textOf(b) && isPinEligible(b.dataset.promptOrigin, { conducted }));
      eligibleFor = conducted;
    }
    const list = eligible;
    const top0 = scrollEl.getBoundingClientRect().top + scrollEl.clientTop;
    const topAt = (i: number) => list[i].getBoundingClientRect().top - top0;
    const shown = pinStore.get().pin;
    // A pushed-off pin is hidden and measures 0: it keeps its last height.
    if (pinEl && (shown.kind === 'status' || (shown.kind === 'pinned' && !shown.pushedOff))) pinHeight = pinEl.offsetHeight;
    let pick = pickPinned(topAt, list.length, pinned ? pinHeight : 0);
    if (!pick) {
      if (!(scrollEl.clientHeight > 0)) { hide(); return; }
      const text = statusText();
      if (shown.kind !== 'status' || shown.text !== text) set({ kind: 'status', text });
      pinned = null;
      kick();
      return;
    }
    const bubble = list[pick.index];
    if (bubble !== pinned) {
      pinned = bubble;
      set({ kind: 'pinned', html: textOf(bubble)!.innerHTML, shift: 0, overflowing: false, pushedOff: false });
      // Measure the freshly rendered pin before positioning it.
      requestAnimationFrame(() => {
        if (!pinEl) return;
        pinHeight = pinEl.offsetHeight;
        const p = pickPinned(topAt, list.length, pinHeight);
        const body = pinEl.querySelector<HTMLElement>('[data-pin-body]');
        const cur = pinStore.get().pin;
        if (cur.kind === 'pinned' && p) set({ ...cur, shift: p.shift, overflowing: !!body && body.scrollHeight > body.clientHeight + 1, pushedOff: isPushedOff(p.shift) });
      });
      return;
    }
    const cur = pinStore.get().pin;
    pick = pickPinned(topAt, list.length, pinHeight);
    if (cur.kind === 'pinned' && pick) {
      const pushedOff = isPushedOff(pick.shift);
      if (cur.shift !== pick.shift || cur.pushedOff !== pushedOff) set({ ...cur, shift: pick.shift, pushedOff });
    }
  }

  return {
    attach(scroll: HTMLElement, list: HTMLElement, pin: HTMLElement) {
      scrollEl = scroll;
      listEl = list;
      pinEl = pin;
      observer = new MutationObserver(() => { eligible = null; refreshSoon(); });
      observer.observe(list, { childList: true });
      scroll.addEventListener('scroll', refreshSoon, { passive: true });
      scroll.addEventListener('toggle', refreshSoon, true);
      addEventListener('resize', refreshSoon);
      return () => {
        observer?.disconnect();
        scroll.removeEventListener('scroll', refreshSoon);
        scroll.removeEventListener('toggle', refreshSoon, true);
        removeEventListener('resize', refreshSoon);
        scrollEl = listEl = pinEl = null;
      };
    },
    jumpToPinned() {
      if (!pinned?.isConnected || !scrollEl) return;
      const top0 = scrollEl.getBoundingClientRect().top + scrollEl.clientTop;
      scrollEl.scrollTop += pinned.getBoundingClientRect().top - top0;
    },
    reveal() {
      revealed = true;
      revealedFor = getActiveId();
      failed = false;
      refresh();
    },
    conceal() {
      stopRevealing();
      refresh();
    },
    refresh,
  };
}

export const SWIPE_MIN_PX = 40;

/** Vertical swipe detection on a zone: down reveals, up conceals; horizontal swipes are ignored. */
export function trackSwipes(zone: HTMLElement, onDown: () => void, onUp: () => void) {
  let start: { x: number; y: number } | null = null;
  const passive = { passive: true } as const;
  const onStart = (e: TouchEvent) => {
    start = e.touches.length === 1 && !(e.target as Element)?.closest?.('[role="menu"]')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  };
  const onMove = (e: TouchEvent) => {
    if (!start) return;
    if (e.touches.length > 1) { start = null; return; }
    const dx = e.touches[0].clientX - start.x;
    const dy = e.touches[0].clientY - start.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax >= SWIPE_MIN_PX && ax > ay) { start = null; return; }
    if (ay >= SWIPE_MIN_PX && ay >= 2 * ax) {
      start = null;
      if (dy > 0) onDown(); else onUp();
    }
  };
  const stop = () => { start = null; };
  zone.addEventListener('touchstart', onStart, passive);
  zone.addEventListener('touchmove', onMove, passive);
  zone.addEventListener('touchend', stop, passive);
  zone.addEventListener('touchcancel', stop, passive);
  return () => {
    zone.removeEventListener('touchstart', onStart);
    zone.removeEventListener('touchmove', onMove);
    zone.removeEventListener('touchend', stop);
    zone.removeEventListener('touchcancel', stop);
  };
}
