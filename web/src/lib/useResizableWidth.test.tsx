// The shared edge resizer through a tiny harness: its edge, its release and
// collapse contracts, its uncapped preference and its cancel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RESIZE_KEY_STEP, useResizableWidth, type ResizableWidthOptions } from './useResizableWidth';

const KEY = 'test:resizable-width';
const BASE: ResizableWidthOptions = { storageKey: KEY, min: 200, max: 600, defaultWidth: 300, edge: 'right', label: 'Resize box' };

/** The hook's last returned values, read by the tests. */
let seen: ReturnType<typeof useResizableWidth>;

function Harness(o: Partial<ResizableWidthOptions>) {
  seen = useResizableWidth({ ...BASE, ...o });
  return <div {...seen.handleProps} />;
}

const handle = () => screen.getByRole('separator', { name: 'Resize box' });
const now = () => Number(handle().getAttribute('aria-valuenow'));

function drag(dx: number, end: 'pointerUp' | 'pointerCancel' = 'pointerUp') {
  act(() => {
    fireEvent.pointerDown(handle(), { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 500 + dx, pointerId: 1 });
  });
  act(() => { fireEvent[end](handle(), { clientX: 500 + dx, pointerId: 1 }); });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('useResizableWidth', () => {
  it('edge left inverts the drag and the keys: +dx narrows, ArrowLeft widens', () => {
    // Invariant: a handle on the box's left edge grows the box as it moves left, by pointer and by key alike.
    localStorage.setItem(KEY, '400');
    render(<Harness edge="left" />);
    drag(40);
    expect(now()).toBe(360);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(now()).toBe(360 + RESIZE_KEY_STEP);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(now()).toBe(360);
  });

  it('a release the caller handles (onRelease false) commits nothing, and one it accepts commits the clamped width', () => {
    // Invariant: onRelease sees the unclamped raw width; false leaves storage and width alone, true commits clamp(raw).
    localStorage.setItem(KEY, '400');
    const onRelease = vi.fn(() => false);
    const { rerender } = render(<Harness onRelease={onRelease} />);
    const setItem = vi.spyOn(localStorage, 'setItem');
    drag(400);
    expect(onRelease).toHaveBeenLastCalledWith(800);
    expect(setItem).not.toHaveBeenCalled();
    expect(now()).toBe(400);
    rerender(<Harness onRelease={() => true} />);
    drag(400);
    expect(setItem).toHaveBeenLastCalledWith(KEY, '600');
    expect(now()).toBe(600);
  });

  it('collapsed reads 0 between 0 and max and drags from 0; its grow key opens it through onToggle, writing nothing, and its shrink key does nothing', () => {
    // Invariant: a collapsible handle at its collapsed end reports and starts from 0; the keys can only open it, the way Enter does, and never overwrite the stored width.
    const onRelease = vi.fn(() => false);
    const onToggle = vi.fn();
    localStorage.setItem(KEY, '400');
    render(<Harness collapsible collapsed onRelease={onRelease} onToggle={onToggle} />);
    expect(now()).toBe(0);
    expect(handle().getAttribute('aria-valuemin')).toBe('0');
    drag(250);
    expect(onRelease).toHaveBeenLastCalledWith(250);
    const setItem = vi.spyOn(localStorage, 'setItem');
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(onToggle, 'shrinking a collapsed handle').not.toHaveBeenCalled();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(onToggle, 'growing opens it').toHaveBeenCalledTimes(1);
    expect(setItem, 'no width written').not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe('400');
  });

  it('an arrow key the limit stops writes nothing', () => {
    // Invariant: a key that does not change the width (clamped at a limit) writes no width.
    localStorage.setItem(KEY, String(BASE.max));
    render(<Harness />);
    const setItem = vi.spyOn(localStorage, 'setItem');
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(now()).toBe(BASE.max);
    expect(setItem, 'no width written').not.toHaveBeenCalled();
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(setItem, 'a key that moves it still writes').toHaveBeenLastCalledWith(KEY, String(BASE.max - RESIZE_KEY_STEP));
  });

  it('mid-drag the handle reports the live width, not the width the drag started from', () => {
    // Invariant: aria-valuenow follows the pointer between pointerdown and pointerup.
    localStorage.setItem(KEY, '400');
    render(<Harness />);
    act(() => {
      fireEvent.pointerDown(handle(), { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(handle(), { clientX: 540, pointerId: 1 });
    });
    expect(seen.live).toBe(440);
    expect(now(), 'the live width').toBe(440);
    act(() => { fireEvent.pointerUp(handle(), { clientX: 540, pointerId: 1 }); });
    expect(now()).toBe(440);
  });

  it('preferred is the stored width uncapped by max, and width is it capped', () => {
    // Invariant: a ceiling that shrinks (a narrower window) caps the shown width without forgetting the stored preference.
    localStorage.setItem(KEY, '900');
    render(<Harness />);
    expect(seen.preferred).toBe(900);
    expect(seen.width).toBe(600);
  });

  it('a cancelled drag commits nothing and drops the live width', () => {
    // Invariant: pointercancel discards a drag: no storage write and the width shown reverts.
    localStorage.setItem(KEY, '400');
    render(<Harness />);
    const setItem = vi.spyOn(localStorage, 'setItem');
    drag(80, 'pointerCancel');
    expect(setItem).not.toHaveBeenCalled();
    expect(seen.live).toBeNull();
    expect(now()).toBe(400);
  });

  it('Enter calls onToggle, and without one resets to the default by removing the key', () => {
    // Invariant: Enter is the keyboard's double-click: the caller's toggle when given, else forget the width.
    const onToggle = vi.fn();
    localStorage.setItem(KEY, '400');
    const { unmount } = render(<Harness onToggle={onToggle} />);
    fireEvent.keyDown(handle(), { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledTimes(1);
    unmount();
    render(<Harness />);
    fireEvent.keyDown(handle(), { key: 'Enter' });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(now()).toBe(BASE.defaultWidth);
  });
});
