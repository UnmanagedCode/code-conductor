// The desktop sidebar's resize handle as a WAI-ARIA window splitter: focusable,
// reporting its value and limits, resized by the arrow keys, and flagging the
// body for the length of a drag so an iframe under the pointer cannot swallow it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { appStore } from '@/state/app';
import { uiStore } from '@/app/ui';

vi.mock('@/app/controller', () => ({
  selectInstance: vi.fn(), send: vi.fn(), refreshProjects: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('@/app/sessionActions', () => ({
  loadSessions: vi.fn(async () => []), closeSession: vi.fn(), resumeSession: vi.fn(), promoteSession: vi.fn(), removeWorktree: vi.fn(),
}));
vi.mock('@/features/views/AppSwitcher', () => ({ AppSwitcher: () => null }));
vi.mock('@/features/notifications/NotifyToggle', () => ({ NotifyToggle: () => null }));

const { AppSidebar } = await import('./AppSidebar');
const { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } = await import('./derive');

const aside = () => document.querySelector('aside[data-sidebar]') as HTMLElement;
const widthPx = () => parseInt(aside().style.width, 10);

/** Renders the desktop column over `stored` and returns its separator, asserted present. */
function mount(stored: number | null) {
  if (stored !== null) localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(stored));
  render(<TooltipProvider><AppSidebar /></TooltipProvider>);
  const handle = screen.queryByRole('separator', { name: 'Resize sidebar' });
  expect(handle, 'the resize separator').not.toBeNull();
  return handle!;
}

/** The separator's numeric aria value, asserted present. */
function aria(handle: HTMLElement, name: 'aria-valuenow' | 'aria-valuemin' | 'aria-valuemax') {
  const v = handle.getAttribute(name);
  expect(v, name).not.toBeNull();
  return Number(v);
}

beforeEach(() => {
  localStorage.clear();
  uiStore.set({ lens: 'conductors' });
  appStore.set({
    connection: 'open', everDropped: false, activeId: null, sidebarStatus: null,
    projects: [], workspaces: [], conductSessions: [], conductorSpawns: {}, instances: [],
  });
  // happy-dom lays nothing out: give the column the box its style width would give it in a browser.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const w = parseFloat(this.style.width) || 0;
    return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: w, width: w, height: 0, toJSON() {} } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.body.dataset.resizing;
  document.body.style.userSelect = '';
});

describe('the sidebar resize separator', () => {
  it('is focusable and reports the stored width between the sidebar limits', () => {
    // Invariant: a keyboard user can reach the separator, and assistive tech reads its current width and range.
    const handle = mount(300);
    expect(handle.tabIndex).toBe(0);
    expect(aria(handle, 'aria-valuenow')).toBe(300);
    expect(aria(handle, 'aria-valuemin')).toBe(SIDEBAR_MIN_WIDTH);
    expect(aria(handle, 'aria-valuemax')).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('ArrowRight widens and ArrowLeft narrows the column by the same step, the column follows the value and each key persists it', () => {
    // Invariant: the arrow keys resize the column as a drag does, and each keyed width is committed to the same storage key.
    const handle = mount(300);
    const setItem = vi.spyOn(localStorage, 'setItem');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    const grown = aria(handle, 'aria-valuenow');
    expect(grown).toBeGreaterThan(300);
    expect(widthPx(), 'the column follows').toBe(grown);
    expect(setItem).toHaveBeenLastCalledWith(SIDEBAR_WIDTH_STORAGE_KEY, String(grown));
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(aria(handle, 'aria-valuenow'), 'back by the same step').toBe(300);
    expect(widthPx(), 'the column follows').toBe(300);
    expect(setItem).toHaveBeenLastCalledWith(SIDEBAR_WIDTH_STORAGE_KEY, '300');
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ArrowRight', SIDEBAR_MAX_WIDTH - 4, SIDEBAR_MAX_WIDTH],
    ['ArrowLeft', SIDEBAR_MIN_WIDTH + 2, SIDEBAR_MIN_WIDTH],
  ])('%s from %i stops at the limit %i', (key, stored, limit) => {
    // Invariant: a keyed width never leaves the sidebar's limits.
    const handle = mount(stored);
    fireEvent.keyDown(handle, { key });
    expect(aria(handle, 'aria-valuenow')).toBe(limit);
    expect(widthPx()).toBe(limit);
  });

  it.each(['pointerUp', 'pointerCancel'] as const)('flags the body as resizing from pointerdown until %s', (end) => {
    // Invariant: while a drag is in progress body[data-resizing] is set (the stylesheet then turns pointer events off on iframes), and the drag's end clears it.
    const handle = mount(300);
    expect('resizing' in document.body.dataset, 'precondition: not flagged').toBe(false);
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    expect('resizing' in document.body.dataset, 'flagged during the drag').toBe(true);
    fireEvent.pointerMove(handle, { clientX: 510, pointerId: 1 });
    fireEvent[end](handle, { clientX: 510, pointerId: 1 });
    expect('resizing' in document.body.dataset, 'cleared at its end').toBe(false);
  });

  it('mid-drag the column follows the live width, before the release', () => {
    // Invariant: the aside's width is the live drag width while the pointer moves, not only after pointerup.
    const handle = mount(300);
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 540, pointerId: 1 });
    });
    expect(aria(handle, 'aria-valuenow'), 'the live width').toBe(340);
    expect(widthPx(), 'the column follows mid-drag').toBe(340);
    act(() => { fireEvent.pointerUp(handle, { clientX: 540, pointerId: 1 }); });
  });

  it('a drag resizes the column and persists on release, and a double-click forgets the width', () => {
    // Invariant (characterization, green before and after the shared hook): a +40 drag from 300 lands on 340 and is stored; a double-click removes the key and shows the default.
    mount(300);
    const handle = document.querySelector('[data-resize-handle]') as HTMLElement;
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 540, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 540, pointerId: 1 });
    });
    expect(widthPx()).toBe(340);
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('340');
    fireEvent.doubleClick(handle);
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
    expect(widthPx()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
