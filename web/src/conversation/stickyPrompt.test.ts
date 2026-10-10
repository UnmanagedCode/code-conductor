import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStickyPrompt, pickPinned, pinStore, STATUS_LOADING, STATUS_NONE, STATUS_FAILED, SWIPE_MIN_PX, trackSwipes } from './stickyPrompt';
import { ConversationModel, type UserNode } from './model';
import { createLazyHistory } from './lazyHistory';
import { flush, renderModel } from './renderModel';
import { cleanup } from '@testing-library/react';
import { promptOrigin } from '../../../public/promptOrigin.ts';
import { formatUserQuestionAnswers } from '../../../public/userQuestionAnswers.ts';
import { buildWakeStub } from '../../../public/wakeCallback.ts';

describe('pickPinned', () => {
  const tops = (arr: number[]) => (i: number) => arr[i];
  it('a prompt at or below the top is never pinned', () => {
    expect(pickPinned(tops([0, 100]), 2, 40)).toBeNull();
    expect(pickPinned(tops([-1, 100]), 2, 40)).toBeNull();
  });
  it('the last prompt above the top is pinned', () => {
    expect(pickPinned(tops([-500, -200, 300]), 3, 40)).toEqual({ index: 1, shift: 0 });
  });
  it('the next prompt pushes the pin up by exactly the overlap, and takes over once at the top', () => {
    expect(pickPinned(tops([-500, 25]), 2, 40)).toEqual({ index: 0, shift: -15 });
    expect(pickPinned(tops([-500, -2]), 2, 40)).toEqual({ index: 1, shift: 0 });
  });
  it('with every prompt below the top, or no prompts at all, nothing is pinned', () => {
    expect(pickPinned(tops([10, 200]), 2, 50)).toBeNull();
    expect(pickPinned(tops([]), 0, 50)).toBeNull();
  });
  it('the last of three pins unshifted, and the pick agrees with a linear scan at every scroll offset', () => {
    expect(pickPinned(tops([-300, -200, -50]), 3, 50)).toEqual({ index: 2, shift: 0 });
    const doc = Array.from({ length: 41 }, (_, i) => i * 37 - 200);
    for (let scroll = -50; scroll <= 1400; scroll += 13) {
      let expected = -1;
      doc.forEach((top, i) => { if (top - scroll < -1) expected = i; });
      expect(pickPinned((i) => doc[i] - scroll, doc.length, 50)?.index ?? -1, `scroll ${scroll}`).toBe(expected);
    }
  });
  it('a next prompt a pin-height away or farther pushes nothing: the shift is exactly 0', () => {
    expect(pickPinned(tops([-300, 50]), 2, 50)).toEqual({ index: 0, shift: 0 });
    expect(Object.is(pickPinned(tops([-300, 500]), 2, 50)!.shift, 0)).toBe(true);
  });
  it('a next prompt exactly at the 1px tolerance edge has not taken over: the old pin is pushed fully off', () => {
    expect(pickPinned(tops([-300, -1]), 2, 50)).toEqual({ index: 0, shift: -51 });
  });
});

describe('prompt origin stamping', () => {
  const origin = (ev: object, isSub = false) => {
    const m = new ConversationModel({ isSub });
    m.apply({ kind: 'user_echo', userIndex: 1, ...ev });
    return (m.items[0] as UserNode).origin;
  };
  it('typed prompts are typed; attachment-only, slash commands, answers and sub-agent prompts are synthetic', () => {
    expect(origin({ text: 'add a rate limiter' })).toBe('typed');
    expect(origin({ text: '', attachments: [{ kind: 'file', name: 'a.txt' }] })).toBe('synthetic');
    expect(origin({ text: '/compact' })).toBe('synthetic');
    expect(origin({ text: 'x', questionAnswer: { toolUseId: 't', questions: [] } })).toBe('synthetic');
    expect(origin({ text: 'x' }, true)).toBe('synthetic');
  });
  it('a lazy page stamps its prompts exactly as the live view does', () => {
    const live = new ConversationModel();
    live.apply({ kind: 'user_echo', text: 'hello' });
    const page = live.renderPage([{ kind: 'user_echo', text: 'hello' }], null, null);
    expect((page.items[0] as UserNode).origin).toBe((live.items[0] as UserNode).origin);
  });
});

// ── The controller, against a hand-built transcript with stubbed geometry ──

type Rig = ReturnType<typeof makeRig>;
function makeRig({ conducted = false, historyVisible = false, ready = true, list: givenList, lazy }: {
  conducted?: boolean; historyVisible?: boolean; ready?: boolean; list?: HTMLElement; lazy?: ReturnType<typeof createLazyHistory>;
} = {}) {
  const scroll = document.createElement('div');
  const list = givenList ?? document.createElement('div');
  const pin = document.createElement('div');
  if (!givenList) scroll.appendChild(list);
  document.body.append(scroll, pin);
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => rig.clientHeight });
  scroll.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  // A hidden pin measures 0, as in a browser.
  Object.defineProperty(pin, 'offsetHeight', {
    configurable: true,
    get: () => { const p = pinStore.get().pin; return p.kind === 'hidden' || (p.kind === 'pinned' && p.pushedOff) ? 0 : rig.pinHeight; },
  });
  const tops = new Map<Element, number>();
  const status = { visible: historyVisible, loading: false };
  const loadUntil = vi.fn<(found: () => boolean, keepGoing: () => boolean) => Promise<string>>(async () => 'exhausted');
  const rig = {
    scroll, list, pin, tops, status, loadUntil, clientHeight: 600, pinHeight: 40, activeId: 'a' as string | null, ready,
    add(text: string, top: number, origin = 'typed') {
      const b = document.createElement('div');
      b.dataset.item = 'user';
      b.dataset.promptOrigin = origin;
      const t = document.createElement('div');
      t.setAttribute('data-user-text', '');
      t.innerHTML = `<p>${text}</p>`;
      b.appendChild(t);
      b.getBoundingClientRect = () => ({ top: tops.get(b) ?? 0 } as DOMRect);
      tops.set(b, top);
      list.appendChild(b);
      return b;
    },
    sticky: null as unknown as ReturnType<typeof createStickyPrompt>,
    detach: () => {},
  };
  rig.sticky = createStickyPrompt({
    isConducted: () => conducted,
    getActiveId: () => rig.activeId,
    history: lazy ?? { status: { get: () => status }, loadUntil },
    isHistoryReady: lazy ? () => lazy.isReady() : () => rig.ready,
  });
  rig.detach = rig.sticky.attach(scroll, list, pin);
  return rig;
}
const pin = () => pinStore.get().pin;
const frame = () => new Promise((r) => setTimeout(r, 40));

/** A bubble at document offset `docTop`: its rect follows the scroll root's scrollTop. */
function addAt(r: Rig, text: string, docTop: number) {
  const b = r.add(text, 0);
  b.getBoundingClientRect = () => ({ top: docTop - r.scroll.scrollTop } as DOMRect);
  return b;
}
function scrollTo(r: Rig, y: number) {
  r.scroll.scrollTop = y;
  r.sticky.refresh();
}
type Run = { found: () => boolean; keepGoing: () => boolean; resolve: (result: string) => void };
/** Each history run stays pending until its recorded `resolve` is called. */
function pendingRuns(r: Rig) {
  const runs: Run[] = [];
  r.loadUntil.mockImplementation((found, keepGoing) => new Promise<string>((resolve) => { runs.push({ found, keepGoing, resolve }); }));
  return runs;
}
function withBody(r: Rig, scrollH: number, clientH: number) {
  const body = document.createElement('div');
  body.setAttribute('data-pin-body', '');
  Object.defineProperty(body, 'scrollHeight', { configurable: true, value: scrollH });
  Object.defineProperty(body, 'clientHeight', { configurable: true, value: clientH });
  r.pin.appendChild(body);
}
function stubWidths(r: Rig, offsetWidth: number, clientWidth: number, clientLeft: number) {
  Object.defineProperty(r.scroll, 'offsetWidth', { configurable: true, value: offsetWidth });
  Object.defineProperty(r.scroll, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(r.scroll, 'clientLeft', { configurable: true, value: clientLeft });
}
/** Every pin store notification, as the state it left. */
function writes() {
  const list: ReturnType<typeof pinStore.get>[] = [];
  const off = pinStore.subscribe(() => { list.push(pinStore.get()); });
  return { list, off };
}

/** A real model's bubbles, rendered by ItemsList, as the controller's list. */
async function rendered(events: object[], opts: { conducted?: boolean } = {}) {
  const m = new ConversationModel();
  for (const ev of events) m.apply(ev as any);
  const { root } = renderModel(m);
  await flush();
  const bubbles = root.querySelectorAll<HTMLElement>(':scope > [data-item="user"]');
  return { root, bubbles, rig: makeRig({ ...opts, list: root }) };
}
const placeAt = (b: HTMLElement, top: number) => { b.getBoundingClientRect = () => ({ top } as DOMRect); };

let rig: Rig;
beforeEach(() => { pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 }); });
afterEach(() => { rig?.detach(); document.body.innerHTML = ''; });

describe('rendered bubbles', () => {
  it('a bubble with no user-text block is stamped synthetic even when promptOrigin reads the event as typed, and never pins', async () => {
    expect(promptOrigin({ kind: 'user_echo', text: '<transcribed>\n', parentToolUseId: null } as any)).toBe('typed');
    const r = await rendered([
      { kind: 'user_echo', text: '<transcribed>\n', userIndex: 0 },
      { kind: 'user_echo', text: 'next prompt', userIndex: 1 },
    ]);
    rig = r.rig;
    expect(r.bubbles).toHaveLength(2);
    expect(r.bubbles[0].querySelector('[data-user-text]')).toBeNull();
    expect(r.bubbles[0].dataset.promptOrigin).toBe('synthetic');
    placeAt(r.bubbles[0], -300);
    placeAt(r.bubbles[1], 600);
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });

  it('a stamped question-answer bubble, faithful or raw fallback, is synthetic and never pins, even in a conducted session', async () => {
    const questions = [{ question: 'Pick', header: 'P', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
    const faithful = formatUserQuestionAnswers(questions as any, [{ kind: 'option', label: 'A' } as any]);
    const raw = 'Answer to "Pick": line one\nline two';
    for (const text of [faithful, raw]) {
      rig?.detach();
      cleanup();
      document.body.innerHTML = '';
      pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 });
      const r = await rendered([
        { kind: 'user_echo', text, userIndex: 0, questionAnswer: { toolUseId: 'toolu_q', questions } },
        { kind: 'user_echo', text: 'next prompt', userIndex: 1 },
      ], { conducted: true });
      rig = r.rig;
      expect(r.bubbles, text).toHaveLength(2);
      expect(r.bubbles[0].dataset.promptOrigin, text).toBe('synthetic');
      placeAt(r.bubbles[0], -300);
      placeAt(r.bubbles[1], 600);
      rig.sticky.reveal();
      expect(pin(), text).toEqual({ kind: 'status', text: STATUS_NONE });
    }
  });

  it('a synthetic turn, a wake stub or a slash command, never pins, even in a conducted session', async () => {
    const r = await rendered([
      { kind: 'user_echo', text: buildWakeStub({ targetSessionId: 'abcd1234', payloadText: 'worker output' }), userIndex: 0 },
      { kind: 'user_echo', text: '/clear', userIndex: 1 },
    ], { conducted: true });
    rig = r.rig;
    expect(r.bubbles).toHaveLength(2);
    expect([...r.bubbles].map((b) => b.dataset.promptOrigin)).toEqual(['synthetic', 'synthetic']);
    placeAt(r.bubbles[0], -300);
    placeAt(r.bubbles[1], -100);
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });
});

describe('sticky prompt', () => {
  it('stays hidden until revealed, even with a prompt scrolled past; conceal hides it again', () => {
    rig = makeRig();
    rig.add('first', -300);
    rig.sticky.refresh();
    expect(pin().kind).toBe('hidden');
    rig.sticky.reveal();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>first</p>' });
    rig.sticky.conceal();
    expect(pin().kind).toBe('hidden');
  });

  it('pins the last typed prompt above the top; scrolling back above it shows the older one', () => {
    rig = makeRig();
    const a = rig.add('older', -800);
    const b = rig.add('newer', -100);
    rig.sticky.reveal();
    expect(pin()).toMatchObject({ html: '<p>newer</p>' });
    rig.tops.set(b, 200);
    rig.tops.set(a, -300);
    rig.sticky.refresh();
    expect(pin()).toMatchObject({ html: '<p>older</p>' });
  });

  it('the next prompt pushes the pin off by the overlap', async () => {
    rig = makeRig();
    rig.add('a', -500);
    const b = rig.add('b', 300);
    rig.sticky.reveal();
    await frame();
    rig.tops.set(b, 25);
    rig.sticky.refresh();
    expect(pin()).toMatchObject({ kind: 'pinned', shift: -15 });
  });

  it('a template prompt pins only in a conducted session; synthetic turns never pin', () => {
    rig = makeRig();
    rig.add('template', -100, 'template');
    rig.add('stub', -50, 'synthetic');
    rig.sticky.reveal();
    expect(pin().kind).toBe('status');
    rig.detach();
    document.body.innerHTML = '';
    rig = makeRig({ conducted: true });
    rig.add('template', -100, 'template');
    rig.sticky.reveal();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>template</p>' });
  });

  it('jumping scrolls the original bubble to the top', () => {
    rig = makeRig();
    rig.add('first', -300);
    rig.sticky.reveal();
    rig.scroll.scrollTop = 1000;
    rig.sticky.jumpToPinned();
    expect(rig.scroll.scrollTop).toBe(700);
  });

  it('a prompt appended later is picked up', async () => {
    rig = makeRig();
    rig.sticky.reveal();
    expect(pin().kind).toBe('status');
    rig.add('late', -10);
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>late</p>' });
  });

  it('with nothing above the top: says none when history is exhausted, loading while it pages', async () => {
    rig = makeRig();
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
    rig.detach();
    document.body.innerHTML = '';
    rig = makeRig({ historyVisible: true });
    rig.loadUntil.mockImplementation(() => new Promise(() => {}));
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_LOADING });
    expect(rig.loadUntil).toHaveBeenCalledTimes(1);
    rig.sticky.refresh();
    expect(rig.loadUntil).toHaveBeenCalledTimes(1);
  });

  it('pages history until a prompt is pinned; found() sees the spliced bubble', async () => {
    rig = makeRig({ historyVisible: true });
    rig.loadUntil.mockImplementation(async (found) => {
      rig.add('from history', -40);
      return found() ? 'found' : 'exhausted';
    });
    rig.sticky.reveal();
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>from history</p>' });
  });

  it('a stalled run shows the failure, is not retried by refreshes, and reveal() retries', async () => {
    rig = makeRig({ historyVisible: true });
    rig.loadUntil.mockResolvedValue('stalled');
    rig.sticky.reveal();
    await frame();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_FAILED });
    rig.sticky.refresh();
    expect(rig.loadUntil).toHaveBeenCalledTimes(1);
    rig.sticky.reveal();
    expect(rig.loadUntil).toHaveBeenCalledTimes(2);
    rig.status.visible = false;
    rig.loadUntil.mockResolvedValue('stalled');
    await frame();
    rig.sticky.refresh();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });

  it('conceal mid-run cancels it; its late result shows nothing', async () => {
    rig = makeRig({ historyVisible: true });
    let resolve!: (r: string) => void;
    let keepGoing!: () => boolean;
    rig.loadUntil.mockImplementation((_f, k) => { keepGoing = k; return new Promise((r) => { resolve = r; }); });
    rig.sticky.reveal();
    rig.sticky.conceal();
    expect(keepGoing()).toBe(false);
    resolve('found');
    await frame();
    expect(pin().kind).toBe('hidden');
  });

  it('no layout starts no run; a session switch conceals and cancels', async () => {
    rig = makeRig({ historyVisible: true });
    rig.clientHeight = 0;
    rig.sticky.reveal();
    expect(rig.loadUntil).not.toHaveBeenCalled();
    expect(pin().kind).toBe('hidden');
    rig.clientHeight = 600;
    rig.sticky.refresh();
    expect(rig.loadUntil).toHaveBeenCalledTimes(1);
    rig.activeId = 'b';
    rig.sticky.refresh();
    expect(pin().kind).toBe('hidden');
  });

  it('history not ready (no snapshot yet, or the session was stopped) reads loading, not none', () => {
    rig = makeRig({ ready: false });
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_LOADING });
  });

  it('re-attaching to a fresh transcript after a detach re-reads its prompts: the pin never holds a detached prompt, and a jump scrolls the fresh one', () => {
    rig = makeRig();
    rig.add('old', -300);
    rig.sticky.reveal();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>old</p>' });
    // A full-page view unmounts the transcript: React removes its root, so the
    // list itself sees no childList change.
    rig.detach();
    rig.scroll.remove();
    rig.pin.remove();
    const scroll = document.createElement('div');
    const list = document.createElement('div');
    const pinEl = document.createElement('div');
    scroll.appendChild(list);
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 600 });
    scroll.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    Object.defineProperty(pinEl, 'offsetHeight', { configurable: true, get: () => 40 });
    const fresh = document.createElement('div');
    fresh.dataset.item = 'user';
    fresh.dataset.promptOrigin = 'typed';
    fresh.innerHTML = '<div data-user-text=""><p>new</p></div>';
    fresh.getBoundingClientRect = () => ({ top: -300 } as DOMRect);
    list.appendChild(fresh);
    document.body.append(scroll, pinEl);
    rig.detach = rig.sticky.attach(scroll, list, pinEl);
    rig.sticky.refresh();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>new</p>' });
    scroll.scrollTop = 1000;
    rig.sticky.jumpToPinned();
    expect(scroll.scrollTop).toBe(700);
  });

  it('a jump to the first prompt lands it at the top, and with no earlier prompt the status line replaces the pin', async () => {
    rig = makeRig();
    addAt(rig, 'first', 100);
    addAt(rig, 'second', 900);
    scrollTo(rig, 400);
    rig.sticky.reveal();
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>first</p>' });
    rig.sticky.jumpToPinned();
    expect(rig.scroll.scrollTop).toBe(100);
    rig.sticky.refresh();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });

  it('a height change under the same pinned bubble updates the push-off on the next refresh, writing only the shift', async () => {
    rig = makeRig();
    addAt(rig, 'first', 0);
    addAt(rig, 'second', 500);
    scrollTo(rig, 430);
    rig.sticky.reveal();
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>first</p>', shift: 0 });
    const before = pinStore.get();
    const w = writes();
    rig.pinHeight = 90;
    rig.sticky.refresh();
    expect(w.list).toHaveLength(1);
    expect(w.list[0]).toEqual({ ...before, pin: { ...before.pin, shift: -20 } });
    w.off();
  });

  it('a jump lands the prompt at the top; the previous prompt is held but fully pushed off, so the pin is hidden', async () => {
    rig = makeRig();
    addAt(rig, 'P1', 0);
    addAt(rig, 'P2', 400);
    addAt(rig, 'P3', 1200);
    scrollTo(rig, 600);
    rig.sticky.reveal();
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P2</p>' });
    rig.sticky.jumpToPinned();
    expect(rig.scroll.scrollTop).toBe(400);
    rig.sticky.refresh();
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P1</p>', pushedOff: true });
  });

  it('scrolling on after a jump shows the held prompt again without re-pinning it', async () => {
    rig = makeRig();
    addAt(rig, 'P1', 0);
    addAt(rig, 'P2', 400);
    addAt(rig, 'P3', 1200);
    scrollTo(rig, 600);
    rig.sticky.reveal();
    await frame();
    rig.sticky.jumpToPinned();
    rig.sticky.refresh();
    await frame();
    const w = writes();
    scrollTo(rig, 380);
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P1</p>', shift: -20, pushedOff: false });
    expect(w.list.length).toBeGreaterThan(0);
    for (const s of w.list) expect(s.pin).toMatchObject({ kind: 'pinned', html: '<p>P1</p>' });
    w.off();
  });

  it('a pin pushed exactly to the top edge is pushed off; one pixel lower it shows', async () => {
    rig = makeRig();
    addAt(rig, 'P1', 0);
    addAt(rig, 'P2', 400);
    scrollTo(rig, 300);
    rig.sticky.reveal();
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P1</p>' });
    scrollTo(rig, 400);
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P1</p>', pushedOff: true });
    scrollTo(rig, 399);
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P1</p>', pushedOff: false, shift: -39 });
  });

  it('nothing left to pin after a jump drops the held prompt for the status line', async () => {
    rig = makeRig();
    addAt(rig, 'P1', 0);
    addAt(rig, 'P2', 400);
    addAt(rig, 'P3', 1200);
    scrollTo(rig, 600);
    rig.sticky.reveal();
    await frame();
    rig.sticky.jumpToPinned();
    rig.sticky.refresh();
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P1</p>' });
    scrollTo(rig, 0);
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });

  it('with nothing to pin, refreshes write nothing to the pin store, revealed or not', async () => {
    // A zero gutter, the value beforeEach seeds: an unchanged gutter is no write either.
    const noGutter = (r: Rig) => {
      stubWidths(r, 1000, 1000, 0);
      expect(Math.max(0, r.scroll.offsetWidth - r.scroll.clientWidth - 2 * r.scroll.clientLeft)).toBe(0);
    };
    rig = makeRig();
    addAt(rig, 'P1', 100);
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
    noGutter(rig);
    let before = pinStore.get();
    let w = writes();
    for (let y = 0; y <= 4; y++) scrollTo(rig, y);
    await frame();
    expect(w.list).toHaveLength(0);
    expect(pinStore.get() === before).toBe(true);
    w.off();

    rig.detach();
    document.body.innerHTML = '';
    rig = makeRig();
    noGutter(rig);
    rig.sticky.refresh();
    before = pinStore.get();
    w = writes();
    for (let i = 0; i < 5; i++) rig.sticky.refresh();
    await frame();
    expect(w.list).toHaveLength(0);
    expect(pinStore.get() === before).toBe(true);
    w.off();
  });

  it('the overflow flag is set only when the pinned text overflows the clamp; one pixel of rounding is not overflow', async () => {
    const cases: [number, number, boolean][] = [[200, 57, true], [40, 57, false], [58, 57, false]];
    for (const [scrollH, clientH, overflowing] of cases) {
      rig?.detach();
      document.body.innerHTML = '';
      pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 });
      rig = makeRig();
      withBody(rig, scrollH, clientH);
      addAt(rig, 'long', -300);
      rig.sticky.reveal();
      await frame();
      expect(pin(), `${scrollH}/${clientH}`).toMatchObject({ kind: 'pinned', overflowing });
    }
  });

  it('clearing the transcript drops the pinned prompt for the status line', async () => {
    rig = makeRig();
    addAt(rig, 'first', -300);
    rig.sticky.reveal();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>first</p>' });
    rig.list.replaceChildren();
    await frame();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });

  it("the pin's right edge follows the scroll root's scrollbar gutter, net of its borders and never negative", () => {
    const cases: [number, number, number, number][] = [[1000, 985, 0, 15], [1000, 1000, 0, 0], [1000, 983, 1, 15], [1000, 999, 1, 0]];
    for (const [offsetWidth, clientWidth, clientLeft, gutter] of cases) {
      rig?.detach();
      document.body.innerHTML = '';
      pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 });
      rig = makeRig();
      stubWidths(rig, offsetWidth, clientWidth, clientLeft);
      addAt(rig, 'p', -300);
      rig.sticky.reveal();
      expect(pinStore.get().gutter, `${offsetWidth}/${clientWidth}/${clientLeft}`).toBe(gutter);
    }
  });

  it('a run that ends exhausted leaves the status reading none', async () => {
    rig = makeRig({ historyVisible: true });
    const runs = pendingRuns(rig);
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_LOADING });
    expect(runs).toHaveLength(1);
    rig.status.visible = false;
    runs[0].resolve('exhausted');
    await frame();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });

  it('a pushed-off pin counts as found and shows no status line', async () => {
    rig = makeRig({ historyVisible: true });
    const runs = pendingRuns(rig);
    addAt(rig, 'P1', 10);
    addAt(rig, 'P2', 400);
    rig.sticky.reveal();
    expect(runs).toHaveLength(1);
    rig.scroll.scrollTop = 400;
    expect(runs[0].found()).toBe(true);
    await frame();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>P1</p>', pushedOff: true });
  });
  it('a view opening mid-run stops the run at its next check, as does unmounting the transcript', () => {
    rig = makeRig({ historyVisible: true });
    const runs = pendingRuns(rig);
    rig.sticky.reveal();
    expect(runs).toHaveLength(1);
    expect(runs[0].keepGoing()).toBe(true);
    rig.clientHeight = 0;
    expect(runs[0].keepGoing()).toBe(false);
    rig.clientHeight = 600;
    expect(runs[0].keepGoing()).toBe(true);
    rig.detach();
    expect(runs[0].keepGoing()).toBe(false);
  });

  it('after a same-session reset (a rewind) a revealed pin reads none without fetching; after a switch it reads loading', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ events: [], nextBefore: 0, hasMore: false }) };
    }));
    try {
      let lazy = createLazyHistory({ model: new ConversationModel(), getActiveId: () => rig.activeId });
      rig = makeRig({ lazy });
      lazy.init({ tailStartSeq: 0 });
      await frame();
      lazy.reset();
      const n = calls.length;
      rig.sticky.reveal();
      await frame();
      expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
      expect(calls.length).toBe(n);

      rig.detach();
      document.body.innerHTML = '';
      pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 });
      lazy = createLazyHistory({ model: new ConversationModel(), getActiveId: () => rig.activeId });
      rig = makeRig({ lazy });
      lazy.init({ tailStartSeq: 0 });
      await frame();
      rig.activeId = 'b';
      lazy.reset();
      rig.sticky.reveal();
      expect(pin()).toEqual({ kind: 'status', text: STATUS_LOADING });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("after switching A, B, then A again, a revealed pin reads loading until A's snapshot, not none", async () => {
    const lazy = createLazyHistory({ model: new ConversationModel(), getActiveId: () => rig.activeId });
    rig = makeRig({ lazy });
    rig.activeId = 'A';
    lazy.init({ tailStartSeq: 1000 });
    for (const id of ['B', 'A']) {
      rig.activeId = id;
      rig.list.replaceChildren();
      lazy.reset();
      await frame();
    }
    rig.sticky.reveal();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_LOADING });
  });

  it('a concealed run resolving after a new reveal neither ends nor fails the new run', async () => {
    rig = makeRig({ historyVisible: true });
    const runs = pendingRuns(rig);
    rig.sticky.reveal();
    rig.sticky.conceal();
    rig.sticky.reveal();
    expect(runs).toHaveLength(2);
    runs[0].resolve('stalled');
    await frame();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_LOADING });
    for (let i = 0; i < 3; i++) rig.sticky.refresh();
    expect(runs).toHaveLength(2);
    expect(pin()).toEqual({ kind: 'status', text: STATUS_LOADING });
  });

  it('a session switch conceals the pin and cancels its run, and the new session starts concealed; a same-session clear keeps it revealed', async () => {
    rig = makeRig({ historyVisible: true });
    const runs = pendingRuns(rig);
    addAt(rig, 'first', 0);
    addAt(rig, 'second', 900);
    rig.sticky.reveal();
    expect(pin().kind).toBe('status');
    expect(runs).toHaveLength(1);
    rig.activeId = 'b';
    rig.list.replaceChildren();
    await frame();
    expect(pin().kind).toBe('hidden');
    expect(runs[0].keepGoing()).toBe(false);
    rig.add('other', -300);
    await frame();
    expect(pin().kind).toBe('hidden');
    rig.sticky.reveal();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>other</p>' });

    rig.detach();
    document.body.innerHTML = '';
    pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 });
    rig = makeRig({ historyVisible: false });
    addAt(rig, 'first', -300);
    rig.sticky.reveal();
    expect(pin()).toMatchObject({ kind: 'pinned', html: '<p>first</p>' });
    rig.list.replaceChildren();
    await frame();
    expect(pin()).toEqual({ kind: 'status', text: STATUS_NONE });
  });
});

describe('reveal gestures', () => {
  function touch(zone: HTMLElement, type: string, points: { x: number; y: number }[], target: Element = zone) {
    const ev = new Event(type, { bubbles: true }) as any;
    Object.defineProperty(ev, 'touches', { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
    target.dispatchEvent(ev);
  }
  function rigZone() {
    const zone = document.createElement('div');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    zone.appendChild(menu);
    const button = document.createElement('button');
    zone.appendChild(button);
    document.body.appendChild(zone);
    const calls: string[] = [];
    trackSwipes(zone, () => calls.push('down'), () => calls.push('up'));
    return { zone, menu, button, calls };
  }

  it('a vertical swipe reveals (down) or conceals (up), once per gesture', () => {
    const { zone, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX * 3 }]);
    touch(zone, 'touchend', []);
    touch(zone, 'touchstart', [{ x: 0, y: 100 }]);
    touch(zone, 'touchmove', [{ x: 0, y: 100 - SWIPE_MIN_PX }]);
    expect(calls).toEqual(['down', 'up']);
  });

  it('short, horizontal-dominant, two-finger or in-menu swipes do nothing; a small sideways lead does not abandon it', () => {
    const { zone, menu, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX - 1 }]);
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: SWIPE_MIN_PX + 5, y: SWIPE_MIN_PX }]);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX * 4 }]);
    touch(zone, 'touchstart', [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    touch(zone, 'touchmove', [{ x: 0, y: 100 }]);
    touch(menu, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: 0, y: 100 }]);
    expect(calls).toEqual([]);
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: 10, y: 5 }]);
    touch(zone, 'touchmove', [{ x: 10, y: SWIPE_MIN_PX + 10 }]);
    expect(calls).toEqual(['down']);
  });

  it('a diagonal move with vertical travel under twice the horizontal does nothing; an exactly 45 degree lead at the threshold does not abandon the swipe', () => {
    const { zone, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: SWIPE_MIN_PX, y: 2 * SWIPE_MIN_PX - 1 }]);
    touch(zone, 'touchend', []);
    expect(calls).toEqual([]);
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: SWIPE_MIN_PX, y: SWIPE_MIN_PX }]);
    touch(zone, 'touchmove', [{ x: SWIPE_MIN_PX, y: 2 * SWIPE_MIN_PX }]);
    expect(calls).toEqual(['down']);
  });

  it('a second finger mid-gesture abandons it, and a gesture that starts with two fingers is never tracked, even after one lifts', () => {
    const { zone, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: 0, y: 5 }, { x: 30, y: 5 }]);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
    expect(calls).toEqual([]);
    touch(zone, 'touchstart', [{ x: 0, y: 0 }, { x: 30, y: 0 }]);
    touch(zone, 'touchend', [{ x: 0, y: 0 }]);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
    touch(zone, 'touchmove', [{ x: 0, y: 3 * SWIPE_MIN_PX }]);
    expect(calls).toEqual([]);
  });

  it('a swipe starting on a button in the zone counts; one starting inside a menu does not', () => {
    const { zone, menu, button, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }], menu);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }], menu);
    expect(calls).toEqual([]);
    touch(zone, 'touchstart', [{ x: 0, y: 0 }], button);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }], button);
    expect(calls).toEqual(['down']);
  });

  it('touchend ends tracking', () => {
    const { zone, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchend', []);
    touch(zone, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
    expect(calls).toEqual([]);
  });

  it('touchcancel ends tracking', () => {
    const { zone, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchcancel', []);
    touch(zone, 'touchmove', [{ x: 0, y: 100 }]);
    expect(calls).toEqual([]);
  });
});
