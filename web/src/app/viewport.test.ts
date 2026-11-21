import { describe, expect, it, vi } from 'vitest';
import { APP_HEIGHT_VAR, APP_LEFT_VAR, APP_TOP_VAR, HEIGHT_SLACK_PX, startViewportFollow } from './viewport';

const LAYOUT = 844;

type Init = {
  /** The layout viewport, documentElement.clientHeight: the keyboard never shrinks it. */
  layout?: number;
  /** Independent of the layout height: iOS's standalone webview shrinks it with the keyboard. */
  innerHeight?: number;
  height?: number;
  scale?: number;
  offsetTop?: number;
  offsetLeft?: number;
  scrollY?: number;
  noVv?: boolean;
};

function rig(init: Init = {}) {
  const layout = init.layout ?? LAYOUT;
  const vv = Object.assign(new EventTarget(), {
    height: init.height ?? layout, scale: init.scale ?? 1, offsetTop: init.offsetTop ?? 0, offsetLeft: init.offsetLeft ?? 0,
  });
  const win = {
    visualViewport: init.noVv ? null : vv, innerHeight: init.innerHeight ?? layout, scrollY: init.scrollY ?? 0, scrollTo: vi.fn(),
  } as unknown as { visualViewport: typeof vv | null; innerHeight: number; scrollY: number; scrollTo: ReturnType<typeof vi.fn> };
  const root = document.createElement('div');
  Object.defineProperty(root, 'clientHeight', { value: layout, configurable: true });
  const get = (name: string) => root.style.getPropertyValue(name);
  const all = () => [get(APP_HEIGHT_VAR), get(APP_TOP_VAR), get(APP_LEFT_VAR)];
  return { vv, win, root, get, all };
}

const start = (r: ReturnType<typeof rig>) => startViewportFollow({ win: r.win as never, root: r.root });

describe('startViewportFollow', () => {
  it('in the standalone webview, where innerHeight shrinks with the keyboard, the page still counts as covered', () => {
    // Invariant: coverage is measured against the layout viewport (root.clientHeight), never innerHeight.
    const r = rig({ innerHeight: 500, height: 500 });
    start(r);
    expect(r.get(APP_HEIGHT_VAR), 'the shell takes the visible height').toBe('500px');
    expect(r.get(APP_TOP_VAR), 'the shell top is published with it').toBe('0px');
    expect(r.get(APP_LEFT_VAR), 'the shell left is published with it').toBe('0px');
  });

  it("while covered, every pan of the visual viewport moves the shell with it and keeps its height", () => {
    // Invariant: the shell follows iOS's keyboard pan on each re-pan (one per keystroke), not just the first.
    const r = rig({ height: 500 });
    start(r);
    r.vv.offsetTop = 120; r.vv.offsetLeft = 8;
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.get(APP_TOP_VAR), 'top mirrors offsetTop').toBe('120px');
    expect(r.get(APP_LEFT_VAR), 'left mirrors offsetLeft').toBe('8px');
    expect(r.get(APP_HEIGHT_VAR), 'a pan keeps the height').toBe('500px');
    r.vv.offsetTop = 60;
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.get(APP_TOP_VAR), 'a re-pan re-mirrors offsetTop').toBe('60px');
  });

  it('while covered at scale 1, nothing scrolls the page back, even with a scrolled document', () => {
    // Invariant: nothing cancels iOS's pan while covered — a reset there is the per-keystroke flicker.
    const r = rig({ height: 500, scrollY: 300, offsetTop: 120 });
    start(r);
    r.vv.dispatchEvent(new Event('resize'));
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.win.scrollTo, 'no scrollTo while covered').not.toHaveBeenCalled();
  });

  it('the keyboard closing removes all three variables together, even while an offset remains', () => {
    // Invariant: the variables are removed together; an offset is never published without a shrunk height.
    const r = rig({ height: 500, offsetTop: 120, offsetLeft: 8 });
    start(r);
    expect(r.all(), 'control: all three are set while covered').toEqual(['500px', '120px', '8px']);
    r.vv.height = LAYOUT;
    r.vv.dispatchEvent(new Event('resize'));
    expect(r.all(), 'uncovered: none is set').toEqual(['', '', '']);
  });

  it('uncovered at scale 1, only a leftover document scroll is reset, never a visual offset', () => {
    // Invariant: scrollTo(0, 0) runs for a scrolled document (scrollY !== 0) alone; a visual-viewport offset is not a reason.
    const r = rig();
    start(r);
    r.win.scrollY = 40;
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.win.scrollTo, 'a scrolled document is reset').toHaveBeenCalledTimes(1);
    expect(r.win.scrollTo).toHaveBeenCalledWith(0, 0);
    r.win.scrollY = 0; r.vv.offsetTop = 30;
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.win.scrollTo, 'a visual offset alone is not reset').toHaveBeenCalledTimes(1);
  });

  it('pinch-zoomed and covered, the height follows in screen px but the shell is not moved and nothing scrolls', () => {
    // Invariant: no translate under pinch-zoom — that pan is the user's; the height still follows (height x scale).
    const r = rig({ scale: 2, height: 211, offsetTop: 200, scrollY: 50 });
    start(r);
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.all(), 'height only').toEqual(['422px', '', '']);
    expect(r.win.scrollTo, 'a pinch-zoom pan is never fought').not.toHaveBeenCalled();
  });

  it('pinch-zoomed and not covered, nothing is set and nothing scrolls', () => {
    // Invariant: a pinch-zoom pan is never fought, and a full-height zoomed view (422 x 2) is not covered.
    const r = rig({ scale: 2, height: 422, offsetTop: 200, scrollY: 50 });
    start(r);
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.all()).toEqual(['', '', '']);
    expect(r.win.scrollTo).not.toHaveBeenCalled();
  });

  it('syncs at start without an event', () => {
    // Invariant: an app opened with the keyboard already up gets the height and offset immediately.
    const r = rig({ height: 400, offsetTop: 30 });
    start(r);
    expect(r.all()).toEqual(['400px', '30px', '0px']);
  });

  it('without visualViewport it does nothing and returns a stop', () => {
    // Invariant: a browser lacking visualViewport is left untouched.
    const r = rig({ noVv: true });
    expect(() => start(r)()).not.toThrow();
    expect(r.all()).toEqual(['', '', '']);
  });

  it('after stop() events change nothing', () => {
    // Invariant: stop removes both listeners.
    const r = rig();
    const stop = start(r);
    stop();
    r.vv.height = 500; r.vv.offsetTop = 50; r.win.scrollY = 40;
    r.vv.dispatchEvent(new Event('resize')); r.vv.dispatchEvent(new Event('scroll'));
    expect(r.all()).toEqual(['', '', '']);
    expect(r.win.scrollTo).not.toHaveBeenCalled();
  });

  it('a visible height exactly the slack under the layout height sets nothing', () => {
    // Invariant: the boundary is exclusive: a viewport HEIGHT_SLACK_PX short is rounding, not a keyboard.
    const h = LAYOUT - HEIGHT_SLACK_PX;
    const r = rig({ height: h, innerHeight: h });
    start(r);
    expect(r.all()).toEqual(['', '', '']);
  });

  it('a visible height inside the slack sets nothing', () => {
    // Invariant: a sub-slack shortfall is absorbed, so the slack term is not dropped.
    const h = LAYOUT - HEIGHT_SLACK_PX / 2;
    const r = rig({ height: h, innerHeight: h });
    start(r);
    expect(r.all()).toEqual(['', '', '']);
  });

  it('a visible height just past the slack under the layout height sets the variable', () => {
    // Invariant: the first height beyond the slack, measured from the layout viewport, counts as covered.
    const h = LAYOUT - HEIGHT_SLACK_PX - 0.5;
    const r = rig({ height: h, innerHeight: h });
    start(r);
    expect(r.get(APP_HEIGHT_VAR)).toBe(`${h}px`);
  });
});
