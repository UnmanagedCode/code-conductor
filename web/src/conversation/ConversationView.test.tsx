import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('@shared/ws', () => ({ bus: new EventTarget(), connect: () => {}, send: () => {} }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { stickyPrompt } from '@/app/controller';
import { ConversationView } from './ConversationView';
import { pinStore, STATUS_NONE, SWIPE_MIN_PX, type PinState } from './stickyPrompt';

const PINNED: PinState = { kind: 'pinned', html: '<p>first</p>', shift: 0, overflowing: false, pushedOff: false };

function mount() {
  const { container } = render(<TooltipProvider><ConversationView /></TooltipProvider>);
  return {
    pin: container.querySelector('[data-pinned-prompt]') as HTMLElement,
    scroll: container.querySelector('[data-conversation]') as HTMLElement,
  };
}
const show = (p: PinState) => act(() => pinStore.set({ pin: p }));
function touch(el: HTMLElement, type: string, points: { x: number; y: number }[]) {
  const ev = new Event(type, { bubbles: true }) as any;
  Object.defineProperty(ev, 'touches', { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
  el.dispatchEvent(ev);
}

afterEach(() => {
  vi.restoreAllMocks();
  act(() => pinStore.set({ pin: { kind: 'hidden' }, gutter: 0 }));
});

// Horizontal padding utilities, with any variant prefix: px-, pl-, pr-, ps-, pe-, p-.
const padX = (el: Element) => el.className.split(/\s+/).filter((c) => /^(?:[\w-]+:)*p[xlrse]?-/.test(c)).sort();
const capClasses = (el: Element) => el.className.split(/\s+/).filter((c) => /^(?:[\w-]+:)*max-w-/.test(c)).sort();

describe('pinned prompt', () => {
  // Invariant: the pin column has the transcript list's width cap and horizontal padding, so their content boxes (and the bubbles in them) coincide.
  it("the pin column carries the transcript list's horizontal padding inside its own width cap", () => {
    const { pin, scroll } = mount();
    show(PINNED);
    const list = scroll.firstElementChild as Element;
    const column = pin.querySelector(':scope > [data-session-width]') as Element;
    expect(padX(list).length).toBeGreaterThan(0);
    expect(capClasses(list).length).toBeGreaterThan(0);
    expect(capClasses(column)).toEqual(capClasses(list));
    expect(padX(column)).toEqual(padX(list));
  });

  // Invariant: the overlay adds no inset outside the column's width cap.
  it('the pin overlay carries no horizontal padding of its own', () => {
    const { pin } = mount();
    show(PINNED);
    expect(padX(pin)).toEqual([]);
  });

  // Invariant: a status line is a status region with no tab stop and no title whose text tells the reader there is nothing earlier; a pinned prompt is the focusable, titled jump button; the swap goes both ways.
  it('a status line is a status region with no jump affordance; a pinned prompt is the jump button again', () => {
    const { pin } = mount();
    const status: PinState = { kind: 'status', text: STATUS_NONE };
    const expectRegion = () => {
      expect(pin.getAttribute('role')).toBe('status');
      expect(pin.hasAttribute('tabindex')).toBe(false);
      expect(pin.hasAttribute('title')).toBe(false);
      expect(pin.hidden).toBe(false);
      expect(pin.textContent).toBe(STATUS_NONE);
    };
    show(status);
    expectRegion();
    show(PINNED);
    expect(pin.getAttribute('role')).toBe('button');
    expect(pin.getAttribute('tabindex')).toBe('0');
    expect(pin.getAttribute('title')).toBeTruthy();
    show(status);
    expectRegion();
  });

  it('clicking the pin, Enter or Space jumps to the pinned prompt; another key does nothing', () => {
    const jump = vi.spyOn(stickyPrompt, 'jumpToPinned').mockImplementation(() => {});
    const { pin } = mount();
    show(PINNED);
    fireEvent.click(pin);
    expect(jump).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(pin, { key: 'Enter' })).toBe(false);
    expect(jump).toHaveBeenCalledTimes(2);
    expect(fireEvent.keyDown(pin, { key: ' ' })).toBe(false);
    expect(jump).toHaveBeenCalledTimes(3);
    expect(fireEvent.keyDown(pin, { key: 'a' })).toBe(true);
    expect(jump).toHaveBeenCalledTimes(3);
  });

  it('a fully pushed-off pin is hidden, so it leaves the tab order; peeking again shows the same pinned text node', () => {
    const { pin } = mount();
    show({ ...PINNED, pushedOff: true });
    expect(pin.hidden).toBe(true);
    const body = pin.querySelector('[data-pin-body]');
    expect(body).not.toBeNull();
    show({ ...PINNED, pushedOff: false });
    expect(pin.hidden).toBe(false);
    expect(pin.querySelector('[data-pin-body]') === body).toBe(true);
  });

  it("the pin's right edge follows the scrollbar gutter the controller measured", () => {
    const { pin } = mount();
    act(() => pinStore.set({ pin: PINNED, gutter: 15 }));
    expect(pin.style.right).toBe('15px');
  });

  it('the pin lives outside the scroll root, and pinning adds nothing to the transcript', () => {
    const { pin, scroll } = mount();
    const before = scroll.firstElementChild!.childElementCount;
    show(PINNED);
    expect(scroll.contains(pin)).toBe(false);
    expect(pin.parentElement === scroll.parentElement).toBe(true);
    expect(scroll.firstElementChild!.childElementCount).toBe(before);
  });

  it('a vertical swipe on the pin reveals (down) or conceals (up); a swipe on the transcript does nothing', () => {
    const reveal = vi.spyOn(stickyPrompt, 'reveal').mockImplementation(() => {});
    const conceal = vi.spyOn(stickyPrompt, 'conceal').mockImplementation(() => {});
    const { pin, scroll } = mount();
    touch(pin, 'touchstart', [{ x: 0, y: 0 }]);
    touch(pin, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
    expect(reveal).toHaveBeenCalledTimes(1);
    touch(pin, 'touchstart', [{ x: 0, y: 100 }]);
    touch(pin, 'touchmove', [{ x: 0, y: 100 - SWIPE_MIN_PX }]);
    expect(conceal).toHaveBeenCalledTimes(1);
    touch(scroll, 'touchstart', [{ x: 0, y: 0 }]);
    touch(scroll, 'touchmove', [{ x: 0, y: SWIPE_MIN_PX }]);
    touch(scroll, 'touchstart', [{ x: 0, y: 100 }]);
    touch(scroll, 'touchmove', [{ x: 0, y: 100 - SWIPE_MIN_PX }]);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(conceal).toHaveBeenCalledTimes(1);
  });
});
