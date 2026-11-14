import { describe, expect, it, vi } from 'vitest';
import { APP_HEIGHT_VAR, HEIGHT_SLACK_PX, startViewportFollow } from './viewport';

function rig(init: { height?: number; scale?: number; offsetTop?: number; scrollY?: number; noVv?: boolean } = {}) {
  const vv = Object.assign(new EventTarget(), { height: init.height ?? 844, scale: init.scale ?? 1, offsetTop: init.offsetTop ?? 0 });
  const win = { visualViewport: init.noVv ? null : vv, innerHeight: 844, scrollY: init.scrollY ?? 0, scrollTo: vi.fn() } as unknown as { visualViewport: typeof vv | null; innerHeight: number; scrollY: number; scrollTo: ReturnType<typeof vi.fn> };
  const root = document.createElement('div');
  const get = () => root.style.getPropertyValue(APP_HEIGHT_VAR);
  return { vv, win, root, get };
}

const start = (r: ReturnType<typeof rig>) => startViewportFollow({ win: r.win as never, root: r.root });

describe('startViewportFollow', () => {
  it('a resize to a shorter visual viewport sets the app height and resets a scrolled page', () => {
    // Invariant: while the keyboard covers the page the shell height follows the visible height, and the keyboard pan is undone at scale 1.
    const r = rig();
    start(r);
    expect(r.get()).toBe('');
    r.vv.height = 500; r.win.scrollY = 300;
    r.vv.dispatchEvent(new Event('resize'));
    expect(r.get()).toBe('500px');
    expect(r.win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('a visual-viewport scroll at scale 1 resets the page to the top', () => {
    // Invariant: a non-zero visual offset at scale 1 is Safari's pan and is reset on the scroll event.
    const r = rig();
    start(r);
    r.vv.offsetTop = 120;
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('while pinch-zoomed it never resets the scroll and a full-height view sets no variable', () => {
    // Invariant: the user's pinch-zoom pan is not fought, and height is measured in screen px (height x scale).
    const r = rig({ scale: 2, height: 422, offsetTop: 200 });
    start(r);
    r.vv.dispatchEvent(new Event('scroll'));
    expect(r.win.scrollTo).not.toHaveBeenCalled();
    expect(r.get()).toBe('');
  });

  it('the keyboard closing removes the variable', () => {
    // Invariant: once the visual viewport is full height again the shell returns to its 100dvh default.
    const r = rig({ height: 500 });
    start(r);
    expect(r.get()).toBe('500px');
    r.vv.height = 844;
    r.vv.dispatchEvent(new Event('resize'));
    expect(r.get()).toBe('');
  });

  it('syncs at start without an event', () => {
    // Invariant: an app opened with the keyboard already up gets the height immediately.
    const r = rig({ height: 400 });
    start(r);
    expect(r.get()).toBe('400px');
  });

  it('without visualViewport it does nothing and returns a stop', () => {
    // Invariant: a browser lacking visualViewport is left untouched.
    const r = rig({ noVv: true });
    expect(() => start(r)()).not.toThrow();
    expect(r.get()).toBe('');
  });

  it('after stop() events change nothing', () => {
    // Invariant: stop removes both listeners.
    const r = rig();
    const stop = start(r);
    stop();
    r.vv.height = 500; r.vv.offsetTop = 50;
    r.vv.dispatchEvent(new Event('resize')); r.vv.dispatchEvent(new Event('scroll'));
    expect(r.get()).toBe('');
    expect(r.win.scrollTo).not.toHaveBeenCalled();
  });

  it('a visible height exactly the slack under innerHeight sets nothing', () => {
    // Invariant: the boundary is exclusive: a viewport HEIGHT_SLACK_PX short is rounding, not a keyboard.
    const r = rig({ height: 844 - HEIGHT_SLACK_PX });
    start(r);
    expect(r.get()).toBe('');
  });

  it('a visible height inside the slack sets nothing', () => {
    // Invariant: a sub-slack shortfall is absorbed, so the slack term is not dropped.
    const r = rig({ height: 844 - HEIGHT_SLACK_PX / 2 });
    start(r);
    expect(r.get()).toBe('');
  });

  it('a visible height just past the slack sets the variable', () => {
    // Invariant: the first height beyond the slack counts as a covered viewport.
    const h = 844 - HEIGHT_SLACK_PX - 0.5;
    const r = rig({ height: h });
    start(r);
    expect(r.get()).toBe(`${h}px`);
  });
});
