import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStickyPrompt, pickPinned, pinStore, STATUS_LOADING, STATUS_NONE, STATUS_FAILED, SWIPE_MIN_PX, trackSwipes } from './stickyPrompt';
import { ConversationModel, type UserNode } from './model';

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
function makeRig({ conducted = false, historyVisible = false, ready = true } = {}) {
  const scroll = document.createElement('div');
  const list = document.createElement('div');
  const pin = document.createElement('div');
  scroll.appendChild(list);
  document.body.append(scroll, pin);
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => rig.clientHeight });
  scroll.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  Object.defineProperty(pin, 'offsetHeight', { configurable: true, get: () => 40 });
  const tops = new Map<Element, number>();
  const status = { visible: historyVisible, loading: false };
  const loadUntil = vi.fn<(found: () => boolean, keepGoing: () => boolean) => Promise<string>>(async () => 'exhausted');
  const rig = {
    scroll, list, pin, tops, status, loadUntil, clientHeight: 600, activeId: 'a' as string | null, ready,
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
    history: { status: { get: () => status }, loadUntil },
    isHistoryReady: () => rig.ready,
  });
  rig.detach = rig.sticky.attach(scroll, list, pin);
  return rig;
}
const pin = () => pinStore.get().pin;
const frame = () => new Promise((r) => setTimeout(r, 40));

let rig: Rig;
beforeEach(() => { pinStore.set({ pin: { kind: 'hidden' } }); });
afterEach(() => { rig?.detach(); document.body.innerHTML = ''; });

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
    document.body.appendChild(zone);
    const calls: string[] = [];
    trackSwipes(zone, () => calls.push('down'), () => calls.push('up'));
    return { zone, menu, calls };
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

  it('touchcancel ends tracking', () => {
    const { zone, calls } = rigZone();
    touch(zone, 'touchstart', [{ x: 0, y: 0 }]);
    touch(zone, 'touchcancel', []);
    touch(zone, 'touchmove', [{ x: 0, y: 100 }]);
    expect(calls).toEqual([]);
  });
});
