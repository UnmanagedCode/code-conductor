// The transcript's scroll position as the reader meets it: stuck to the bottom
// while they are there, left alone once they scroll up, the bottom again for a
// cleared transcript, their place again after a full-page view, kept while
// an older page is spliced above, and following the reader's intent while output
// streams: any move up, or a finger on the transcript, stops the view writing.
// happy-dom lays nothing out, so the scroll root gets a stand-in layout: 100px per
// rendered item less `collapsedPx` (content above that shrank), an 800px view, and
// a scrollTop that only the view's own writes move (clamped as a browser clamps them).
// Its scrollTo lands an instant scroll at once; a smooth one only records its
// destination, clamped when it starts, until `landSmooth`, and an instant write
// before then aborts it. happy-dom's own smooth scroll clamps when it lands, which
// would hide a destination gone stale under a growing transcript.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { bus } from '@shared/ws';
import { conversation, lazyHistory, selectInstance, startController, stopController } from '@/app/controller';
import { appStore } from '@/state/app';
import type { Instance } from '@/state/types';
import type { UiEvent } from '@shared/uiEvent';
import { ConversationView } from './ConversationView';
import { flush } from './renderModel';
import { settle } from '@/test/settle';

const ITEM_PX = 100;
const VIEW_PX = 800;

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });
const echo = (text: string): UiEvent => ({ kind: 'user_echo', text });
const echoes = (tag: string, n: number) => Array.from({ length: n }, (_, i) => echo(`${tag} ${i}`));

// ── Stand-in layout ──────────────────────────────────────────────────────
const tops = new WeakMap<Element, number>();
const isRoot = (el: Element) => el.hasAttribute('data-conversation');
/** Height lost by content above the reader (a block collapsing), in px. */
let collapsedPx = 0;
const contentPx = (el: Element) => Math.max(VIEW_PX, ITEM_PX * el.querySelectorAll('[data-item]').length - collapsedPx);
/** Where a smooth scroll in flight will land. */
const smoothTo = new WeakMap<Element, number>();
const KEYS = ['scrollTop', 'scrollHeight', 'clientHeight', 'scrollTo'] as const;
const own = new Map<string, PropertyDescriptor | undefined>();
function inherited(key: string): PropertyDescriptor {
  for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return d;
  }
  throw new Error(`no ${key} on the element prototypes`);
}
function layOut() {
  const base = Object.fromEntries(KEYS.map((k) => [k, inherited(k)])) as Record<(typeof KEYS)[number], PropertyDescriptor>;
  for (const k of KEYS) own.set(k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k));
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) { return isRoot(this) ? contentPx(this) : base.scrollHeight.get!.call(this); },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return isRoot(this) ? VIEW_PX : base.clientHeight.get!.call(this); },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) { return isRoot(this) ? tops.get(this) ?? 0 : base.scrollTop.get!.call(this); },
    set(this: HTMLElement, v: number) {
      if (!isRoot(this)) return base.scrollTop.set!.call(this, v);
      smoothTo.delete(this);
      tops.set(this, Math.max(0, Math.min(v, contentPx(this) - VIEW_PX)));
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, ...args: unknown[]) {
      if (!isRoot(this)) return (base.scrollTo.value as (...a: unknown[]) => void).apply(this, args);
      const [a, b] = args;
      const to: ScrollToOptions = typeof a === 'object' && a !== null ? a : { top: b as number };
      if (to.top === undefined) return;
      if (to.behavior === 'smooth') smoothTo.set(this, Math.min(to.top, contentPx(this) - VIEW_PX));
      else this.scrollTop = to.top;
    },
  });
}
function unLayOut() {
  for (const k of KEYS) {
    const d = own.get(k);
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
}

// ── Driving the view ─────────────────────────────────────────────────────
const mount = () => {
  const r = render(<TooltipProvider><ConversationView /></TooltipProvider>);
  return { ...r, el: r.container.querySelector('[data-conversation]') as HTMLElement };
};
const jump = (c: HTMLElement) => c.querySelector('button[aria-label="Jump to latest"]');
/** The bottom of `px` of content in the stand-in layout. */
const bottom = (px: number) => px - VIEW_PX;
/** The reader scrolls to `top`: the position, then the browser's scroll event. */
const scrollTo = (el: HTMLElement, top: number) => {
  el.scrollTop = top;
  fireEvent.scroll(el);
};
/** A smooth scroll in flight lands: the position, then the browser's scroll event. */
const landSmooth = (el: HTMLElement) => {
  const to = smoothTo.get(el);
  if (to === undefined) return;
  el.scrollTop = to;
  fireEvent.scroll(el);
};
/** A touch event on `el` with `fingers` touches still down; it bubbles to the window. */
function touch(el: HTMLElement, type: 'touchstart' | 'touchend' | 'touchcancel', fingers: number) {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, 'touches', { value: Array.from({ length: fingers }, () => ({ clientX: 0, clientY: 0 })) });
  act(() => { el.dispatchEvent(ev); });
}
async function frame(type: string, detail: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  await flush();
}
const snapshot = (id: string, events: UiEvent[], extra: object = {}) => frame('snapshot', { id, events, ...extra });
const live = (id: string, ev: UiEvent) => frame('event', { id, ev });
/** Lineage pages the pager fetches, in order; an exhausted queue serves an empty last page. */
let pages: object[] = [];
let paths: string[] = [];

beforeEach(() => {
  layOut();
  collapsedPx = 0;
  pages = [];
  paths = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname;
    // Only lineage pages are the fixture's: the controller's usage poll must not take one off the queue.
    if (!path.endsWith('/lineage-events')) return { ok: true, status: 200, json: async () => ({}) };
    paths.push(path);
    const page = pages.shift() ?? { events: [], hasMore: false, segment: null, nextBefore: null };
    return { ok: true, status: 200, json: async () => page };
  }));
  act(() => { appStore.set({ instances: [inst('i1'), inst('i2')], activeId: 'i1' }); });
  startController();
});

afterEach(() => {
  stopController();
  vi.unstubAllGlobals();
  act(() => {
    appStore.set({ instances: [], activeId: null });
    conversation.clear();
    lazyHistory.reset();
  });
  unLayOut();
});

describe('stick to the bottom', () => {
  it('a snapshot replay leaves the transcript at the bottom', async () => {
    const { container, el } = mount();
    await snapshot('i1', echoes('replayed', 30));
    expect(el.scrollHeight, 'fixture check: the replay overflows the view').toBe(30 * ITEM_PX);
    expect(el.scrollTop).toBe(bottom(30 * ITEM_PX));
    expect(jump(container)).toBeNull();
  });

  it('live event frames keep a reader at the bottom there, frame after frame', async () => {
    const { container, el } = mount();
    await snapshot('i1', echoes('replayed', 30));
    for (let i = 0; i < 3; i++) {
      await live('i1', echo(`live ${i}`));
      expect(el.scrollTop, `after live event ${i}`).toBe(bottom((31 + i) * ITEM_PX));
    }
    expect(jump(container)).toBeNull();
  });

  it('a reader scrolled up stays put across live events, and is offered Jump to latest', async () => {
    const { container, el } = mount();
    await snapshot('i1', echoes('replayed', 30));
    scrollTo(el, 1200);
    for (let i = 0; i < 3; i++) await live('i1', echo(`live ${i}`));
    expect(el.scrollHeight, 'fixture check: the live events rendered').toBe(33 * ITEM_PX);
    expect(el.scrollTop).toBe(1200);
    expect(jump(container)).not.toBeNull();
  });

  it('a transcript that already has content when the view mounts starts at the bottom', async () => {
    await snapshot('i1', echoes('before mount', 30));
    const { container, el } = mount();
    expect(el.scrollTop).toBe(bottom(30 * ITEM_PX));
    expect(jump(container)).toBeNull();
  });

  it('selecting another session puts a reader scrolled up in the previous one at the bottom of the new one', async () => {
    const { container, el } = mount();
    await snapshot('i1', echoes('first', 30));
    scrollTo(el, 1200);
    expect(jump(container), 'precondition: scrolled up in the first session').not.toBeNull();
    act(() => { selectInstance('i2'); });
    await snapshot('i2', echoes('second', 25));
    expect(el.scrollTop).toBe(bottom(25 * ITEM_PX));
    expect(jump(container)).toBeNull();
  });

  it('a reader at the bottom stays there when the transcript is cleared and replayed', async () => {
    const { el } = mount();
    await snapshot('i1', echoes('first', 30));
    expect(el.scrollTop, 'precondition: at the bottom').toBe(bottom(30 * ITEM_PX));
    await snapshot('i1', echoes('again', 35));
    expect(el.scrollTop).toBe(bottom(35 * ITEM_PX));
  });

  it('a reconnect snapshot of the same session puts a reader scrolled up back at the bottom', async () => {
    const { container, el } = mount();
    await snapshot('i1', echoes('before', 30));
    scrollTo(el, 1200);
    await live('i1', echo('held'));
    expect(el.scrollTop, 'precondition: a reader scrolled up is left alone').toBe(1200);
    await snapshot('i1', echoes('reconnected', 26));
    expect(el.scrollTop).toBe(bottom(26 * ITEM_PX));
    expect(jump(container)).toBeNull();
  });
});

describe('a full-page view round trip', () => {
  it('the transcript remounts where the reader left it scrolled up, with what arrived while away below, and stays there', async () => {
    const first = mount();
    await snapshot('i1', echoes('read', 30));
    scrollTo(first.el, 600);
    scrollTo(first.el, 1200);
    expect(jump(first.container), 'precondition: scrolled up').not.toBeNull();
    first.unmount();
    await live('i1', echo('while away'));
    const back = mount();
    expect(back.el.scrollHeight, 'fixture check: what arrived while away rendered').toBe(31 * ITEM_PX);
    expect(back.el.scrollTop).toBe(1200);
    expect(jump(back.container)).not.toBeNull();
    await live('i1', echo('after return'));
    expect(back.el.scrollTop, 'still left alone').toBe(1200);
  });

  it('a reader who scrolled back to the bottom before leaving comes back to the bottom, with what arrived while away', async () => {
    const first = mount();
    await snapshot('i1', echoes('read', 30));
    scrollTo(first.el, 1200);
    scrollTo(first.el, bottom(30 * ITEM_PX));
    expect(jump(first.container), 'precondition: back at the bottom').toBeNull();
    first.unmount();
    await live('i1', echo('while away 0'));
    await live('i1', echo('while away 1'));
    const back = mount();
    expect(back.el.scrollTop).toBe(bottom(32 * ITEM_PX));
    expect(jump(back.container)).toBeNull();
  });

  it('a transcript replaced while the view was away comes back at the bottom: by a snapshot of the same session, and after another session was selected', async () => {
    const first = mount();
    await snapshot('i1', echoes('read', 30));
    scrollTo(first.el, 1200);
    first.unmount();
    await snapshot('i1', echoes('replaced', 25));
    const afterReplace = mount();
    expect(afterReplace.el.scrollTop, 'after a same-session snapshot').toBe(bottom(25 * ITEM_PX));
    expect(jump(afterReplace.container)).toBeNull();

    scrollTo(afterReplace.el, 600);
    afterReplace.unmount();
    act(() => { selectInstance('i2'); });
    await snapshot('i2', echoes('second', 26));
    const afterSwitch = mount();
    expect(afterSwitch.el.scrollTop, 'after another session was selected').toBe(bottom(26 * ITEM_PX));
    expect(jump(afterSwitch.container)).toBeNull();
  });
});

describe('an older page spliced above', () => {
  /**
   * Mounts on a 20-prompt tail whose ring holds more below seq 900. The snapshot's own eager page
   * (it runs before the tail has rendered) is served empty with history still open, so the next
   * page, `older`, comes only when the reader scrolls up to `top`. `beforeScroll` runs just before.
   */
  async function scrolledTail(top: number, older: UiEvent[], beforeScroll: (el: HTMLElement) => void = () => {}) {
    pages = [
      { events: [], hasMore: true, segment: null, nextBefore: 800 },
      { events: older, hasMore: false, segment: null, nextBefore: null },
    ];
    const view = mount();
    await snapshot('i1', echoes('tail', 20), { tailStartSeq: 900 });
    await settle();
    expect(paths, "fixture check: only the snapshot's own page was fetched").toEqual(['/api/instances/i1/lineage-events']);
    expect(view.el.scrollTop, 'fixture check: the tail opens at the bottom').toBe(bottom(20 * ITEM_PX));
    beforeScroll(view.el);
    scrollTo(view.el, top);
    await settle();
    expect(paths.length, 'fixture check: scrolling up fetched the next page').toBe(2);
    return view;
  }

  it("keeps the reader on what they were reading: the position advances by exactly the page's height", async () => {
    const { el } = await scrolledTail(150, echoes('older', 5));
    expect(el.scrollHeight).toBe(25 * ITEM_PX);
    expect(el.scrollTop).toBe(150 + 5 * ITEM_PX);
    const texts = [...el.querySelectorAll('[data-item="user"]')].map((b) => b.textContent ?? '');
    expect(texts.findIndex((t) => t.includes('older 4')) < texts.findIndex((t) => t.includes('tail 0')), 'the page sits above the tail').toBe(true);
  });

  it("is not compensated twice when the browser's own scroll anchoring already moved the position", async () => {
    // Scroll anchoring: content added above the reader moves the position by its height before the view's own fix-up runs.
    let anchoredTo: number | null = null;
    let anchoring: MutationObserver | null = null;
    try {
      const { el } = await scrolledTail(150, echoes('older', 5), (root) => {
        let last = root.scrollHeight;
        anchoring = new MutationObserver(() => {
          const grown = root.scrollHeight - last;
          last = root.scrollHeight;
          if (grown > 0) { root.scrollTop += grown; anchoredTo = root.scrollTop; }
        });
        anchoring.observe(root, { childList: true, subtree: true });
      });
      expect(anchoredTo, 'fixture check: anchoring moved the position first').toBe(150 + 5 * ITEM_PX);
      expect(el.scrollTop).toBe(150 + 5 * ITEM_PX);
    } finally {
      (anchoring as MutationObserver | null)?.disconnect();
    }
  });

  it('an empty older page leaves the position alone', async () => {
    const { el } = await scrolledTail(150, []);
    expect(el.scrollHeight).toBe(20 * ITEM_PX);
    expect(el.scrollTop).toBe(150);
  });
});

describe("following the reader's intent while output streams", () => {
  const BASE = 30 * ITEM_PX;
  /** A 30-prompt replay at the bottom, with the browser's scroll event for the view's own write landing on its own. */
  async function following() {
    const view = mount();
    await snapshot('i1', echoes('replayed', 30));
    fireEvent.scroll(view.el);
    expect(view.el.scrollTop, 'fixture check: at the bottom').toBe(bottom(BASE));
    return view;
  }

  it('a reader who nudges up by less than the affordance band stays where they are as output streams, and is offered Jump to latest', async () => {
    // Invariant: any observed upward move stops following, whatever its distance.
    const { container, el } = await following();
    scrollTo(el, bottom(BASE) - 30);
    await live('i1', echo('live 0'));
    expect(el.scrollTop).toBe(bottom(BASE) - 30);
    expect(jump(container)).not.toBeNull();
  });

  it("a reader's nudge whose scroll event folds into the view's last write still stops following", async () => {
    // Invariant: every write records its landing position as the baseline the next scroll event compares against.
    const { container, el } = await following();
    await live('i1', echo('live 0'));
    expect(el.scrollTop, 'precondition: the frame kept the reader at the bottom').toBe(bottom(BASE + ITEM_PX));
    scrollTo(el, bottom(BASE + ITEM_PX) - 3);
    await live('i1', echo('live 1'));
    expect(el.scrollTop).toBe(bottom(BASE + ITEM_PX) - 3);
    expect(jump(container)).not.toBeNull();
  });

  it('a frame arriving while a finger rests on the transcript at the bottom moves nothing, and offers Jump to latest', async () => {
    // Invariant: nothing is written while a finger is down; the affordance re-syncs without moving.
    const { container, el } = await following();
    touch(el, 'touchstart', 1);
    await live('i1', echo('live 0'));
    expect(el.scrollTop).toBe(bottom(BASE));
    expect(jump(container)).not.toBeNull();
  });

  it('a reader who drags up while a finger is down stays where they dragged to, through a frame and after lifting', async () => {
    // Invariant: a lift after an upward drag does not catch up.
    const { container, el } = await following();
    touch(el, 'touchstart', 1);
    scrollTo(el, bottom(BASE) - 20);
    await live('i1', echo('live 0'));
    expect(el.scrollTop).toBe(bottom(BASE) - 20);
    touch(el, 'touchend', 0);
    expect(el.scrollTop).toBe(bottom(BASE) - 20);
    expect(jump(container)).not.toBeNull();
  });

  it('lifting a finger that held the transcript at the bottom catches up once, with no further frame', async () => {
    // Invariant: lifting the last finger while still following catches up to the bottom.
    const { container, el } = await following();
    touch(el, 'touchstart', 1);
    await live('i1', echo('live 0'));
    expect(el.scrollTop, 'precondition: the frame moved nothing while the finger was down').toBe(bottom(BASE));
    touch(el, 'touchend', 0);
    expect(el.scrollTop).toBe(bottom(BASE + ITEM_PX));
    expect(jump(container)).toBeNull();
  });

  it('Jump to latest clicked while output streams lands on the bottom and keeps following', async () => {
    // Invariant: clicking Jump to latest resumes following, so a smooth scroll overtaken by growth still ends at the bottom.
    const { container, el } = await following();
    scrollTo(el, 1200);
    await live('i1', echo('live 0'));
    const button = jump(container);
    expect(button, 'precondition: scrolled up').not.toBeNull();
    fireEvent.click(button!);
    await live('i1', echo('live 1'));
    expect(el.scrollTop).toBe(bottom(BASE + 2 * ITEM_PX));
    landSmooth(el);
    await live('i1', echo('live 2'));
    expect(el.scrollTop).toBe(bottom(BASE + 3 * ITEM_PX));
    expect(jump(container)).toBeNull();
  });

  it('a reader coming back down into the affordance band is not followed until they reach the very bottom', async () => {
    // Invariant: only the bottom (AT_BOTTOM_PX) resumes following; the affordance band (NEAR_BOTTOM_PX) does not.
    const { container, el } = await following();
    scrollTo(el, 1200);
    scrollTo(el, bottom(BASE) - 30);
    await live('i1', echo('live 0'));
    expect(el.scrollTop).toBe(bottom(BASE) - 30);
    expect(jump(container)).not.toBeNull();
    scrollTo(el, bottom(BASE + ITEM_PX));
    await live('i1', echo('live 1'));
    expect(el.scrollTop).toBe(bottom(BASE + 2 * ITEM_PX));
    expect(jump(container)).toBeNull();
  });

  it('a two-finger gesture holds the transcript until the last finger lifts', async () => {
    // Invariant: the touch gate stays shut until the last touch ends.
    const { container, el } = await following();
    touch(el, 'touchstart', 2);
    touch(el, 'touchend', 1);
    await live('i1', echo('live 0'));
    expect(el.scrollTop).toBe(bottom(BASE));
    touch(el, 'touchend', 0);
    expect(el.scrollTop).toBe(bottom(BASE + ITEM_PX));
    expect(jump(container)).toBeNull();
  });

  it('lifting a finger when no frame was held back moves nothing, even with the transcript short of its bottom', async () => {
    // Invariant: the lift replays only a write the touch gate held back; it does not close a gap no frame opened.
    const { el } = await following();
    // Content grows below without a frame (a card laying out after the view's last write).
    collapsedPx = -24;
    expect(el.scrollHeight - VIEW_PX, 'fixture check: the transcript sits short of its bottom').toBe(bottom(BASE) + 24);
    touch(el, 'touchstart', 1);
    touch(el, 'touchend', 0);
    expect(el.scrollTop).toBe(bottom(BASE));
  });

  it('content above shrinking while a finger is held is not read as the reader moving up', async () => {
    // Invariant: a position drop caused by content shrinking is not an upward move, even after output grew while held.
    const { container, el } = await following();
    touch(el, 'touchstart', 1);
    await live('i1', echo('live 0'));
    expect(el.scrollTop, 'precondition: the frame moved nothing while the finger was down').toBe(bottom(BASE));
    expect(el.scrollHeight - VIEW_PX, 'fixture check: the frame grew the content').toBe(bottom(BASE + ITEM_PX));
    collapsedPx = ITEM_PX;
    // Scroll anchoring: the position drops by what collapsed above it.
    el.scrollTop = bottom(BASE) - ITEM_PX;
    fireEvent.scroll(el);
    touch(el, 'touchend', 0);
    expect(el.scrollTop).toBe(bottom(BASE));
    expect(jump(container)).toBeNull();
  });
});
