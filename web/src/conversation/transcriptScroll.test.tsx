// The transcript's scroll position as the reader meets it: stuck to the bottom
// while they are there, left alone once they scroll up, the bottom again for a
// cleared transcript, their place again after a full-page view, and kept while
// an older page is spliced above. happy-dom lays nothing out, so the scroll root
// gets a stand-in layout: 100px per rendered item, an 800px view, and a
// scrollTop that only the view's own writes move (clamped as a browser clamps them).
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

const ITEM_PX = 100;
const VIEW_PX = 800;

const inst = (id: string): Instance => ({ id, project: 'p', status: 'idle', sessionId: `s-${id}`, mode: 'default' });
const echo = (text: string): UiEvent => ({ kind: 'user_echo', text });
const echoes = (tag: string, n: number) => Array.from({ length: n }, (_, i) => echo(`${tag} ${i}`));

// ── Stand-in layout ──────────────────────────────────────────────────────
const tops = new WeakMap<Element, number>();
const isRoot = (el: Element) => el.hasAttribute('data-conversation');
const contentPx = (el: Element) => Math.max(VIEW_PX, ITEM_PX * el.querySelectorAll('[data-item]').length);
const KEYS = ['scrollTop', 'scrollHeight', 'clientHeight'] as const;
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
      if (isRoot(this)) tops.set(this, Math.max(0, Math.min(v, contentPx(this) - VIEW_PX)));
      else base.scrollTop.set!.call(this, v);
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
async function frame(type: string, detail: object) {
  act(() => { bus.dispatchEvent(new CustomEvent(type, { detail })); });
  await flush();
}
const snapshot = (id: string, events: UiEvent[], extra: object = {}) => frame('snapshot', { id, events, ...extra });
const live = (id: string, ev: UiEvent) => frame('event', { id, ev });
/**
 * A rewind: the server wipes the ring and sends the empty reset, replays into
 * the ring, sends the live history_replayed, and answers the client's
 * re-subscribe with a snapshot of the replayed events.
 */
async function rewind(id: string, replayed: UiEvent[]) {
  await frame('reset_snapshot', { id, events: [] });
  await live(id, { kind: 'system', subtype: 'history_replayed', data: { count: replayed.length } });
  await snapshot(id, replayed.map((ev, i) => ({ ...ev, _seq: i })), { tailStartSeq: 0 });
}

/** Lineage pages the pager fetches, in order; an exhausted queue serves an empty last page. */
let pages: object[] = [];
let paths: string[] = [];

beforeEach(() => {
  layOut();
  pages = [];
  paths = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    paths.push(new URL(url, 'http://localhost').pathname);
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

  it('a rewind puts a reader scrolled up back at the bottom, once the replayed history is pulled', async () => {
    const { container, el } = mount();
    await snapshot('i1', echoes('before', 30));
    scrollTo(el, 1200);
    await live('i1', echo('held'));
    expect(el.scrollTop, 'precondition: a reader scrolled up is left alone').toBe(1200);
    await rewind('i1', echoes('replayed', 25));
    expect(el.scrollHeight, 'fixture check: the replay rendered').toBe(25 * ITEM_PX);
    expect(el.scrollTop).toBe(bottom(25 * ITEM_PX));
    expect(jump(container)).toBeNull();
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

  it('a transcript cleared while the view was away comes back at the bottom: after a rewind, and after another session was selected', async () => {
    const first = mount();
    await snapshot('i1', echoes('read', 30));
    scrollTo(first.el, 1200);
    first.unmount();
    await rewind('i1', echoes('replayed', 25));
    const afterRewind = mount();
    expect(afterRewind.el.scrollTop, 'after a rewind').toBe(bottom(25 * ITEM_PX));
    expect(jump(afterRewind.container)).toBeNull();

    scrollTo(afterRewind.el, 600);
    afterRewind.unmount();
    act(() => { selectInstance('i2'); });
    await snapshot('i2', echoes('second', 26));
    const afterSwitch = mount();
    expect(afterSwitch.el.scrollTop, 'after another session was selected').toBe(bottom(26 * ITEM_PX));
    expect(jump(afterSwitch.container)).toBeNull();
  });
});

describe('an older page spliced above', () => {
  /** Lets in-flight page fetches land and their splices settle. */
  async function settle() {
    await act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); });
  }
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
